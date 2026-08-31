#!/usr/bin/env python3
"""
Prepare missing legacy account dependencies for vBiz Me card migration.

Purpose:
- NEW PostgreSQL schema remains authoritative.
- OLD MySQL is read-only.
- Dry-run by default.
- Creates/links only missing Profession, User, and Subscription records needed
  by selected OLD profiles.
- Never copies legacy passwords, remember tokens, OTPs, or auth secrets.
- Never deletes anything.
- Never changes Package pricing/entitlements.
"""

import argparse
import json
import os
import re
import sys
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path

import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)


def q(name):
    return '"' + name.replace('"', '""') + '"'


def new_text_id():
    # CUID-shaped explicit TEXT id. Prisma accepts explicit IDs for TEXT PKs.
    return "c" + uuid.uuid4().hex[:24]


def norm_name(s):
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def norm_dt(v):
    if v is None:
        return None
    if getattr(v, "tzinfo", None):
        return v.replace(tzinfo=None)
    return v


def old_newer(old_v, new_v):
    a = norm_dt(old_v)
    b = norm_dt(new_v)
    if a is None:
        return False
    if b is None:
        return True
    return a > b


class Prep:
    def __init__(self, args):
        self.args = args
        self.apply = args.apply
        self.events = []
        self.summary = Counter()

        needed = [
            "OLD_MYSQL_HOST", "OLD_MYSQL_USER", "OLD_MYSQL_PASSWORD",
            "OLD_MYSQL_DATABASE", "NEW_DATABASE_URL",
        ]
        missing = [k for k in needed if not os.environ.get(k)]
        if missing:
            fail("Missing env vars: " + ", ".join(missing))

        self.my = pymysql.connect(
            host=os.environ["OLD_MYSQL_HOST"],
            port=int(os.environ.get("OLD_MYSQL_PORT", "3306")),
            user=os.environ["OLD_MYSQL_USER"],
            password=os.environ["OLD_MYSQL_PASSWORD"],
            database=os.environ["OLD_MYSQL_DATABASE"],
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
        )

        pg_url = os.environ["NEW_DATABASE_URL"]
        pg_url = re.sub(r"([?&])schema=public(?:&|$)", "", pg_url).rstrip("?&")
        self.pg = psycopg2.connect(pg_url)
        self.pg.autocommit = False

        self.profile_rows = []
        self.user_map = {}

    def event(self, action, table, **kw):
        row = {"action": action, "table": table}
        for k, v in kw.items():
            if isinstance(v, datetime):
                row[k] = v.isoformat()
            else:
                row[k] = v
        self.events.append(row)
        self.summary[action] += 1

    def pg_one(self, table, where):
        sql = (
            f"SELECT * FROM {q(table)} WHERE " +
            " AND ".join(f"{q(k)}=%s" for k in where) +
            " LIMIT 2"
        )
        with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, tuple(where.values()))
            rows = cur.fetchall()
        if len(rows) > 1:
            return {"__multiple__": True}
        return dict(rows[0]) if rows else None

    def pg_email(self, email):
        if not email:
            return []
        with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                'SELECT * FROM "User" WHERE lower(email)=lower(%s) LIMIT 3',
                (email,),
            )
            return [dict(r) for r in cur.fetchall()]

    def insert(self, table, values, context):
        vals = dict(values)
        if "id" not in vals:
            vals["id"] = new_text_id()

        if not self.apply:
            self.event("WOULD_INSERT", table, newId=vals["id"], **context)
            return vals["id"]

        sql = (
            f"INSERT INTO {q(table)} (" +
            ", ".join(q(k) for k in vals) +
            ") VALUES (" +
            ", ".join(["%s"] * len(vals)) +
            ")"
        )
        with self.pg.cursor() as cur:
            cur.execute(sql, tuple(vals.values()))
        self.event("INSERT", table, newId=vals["id"], **context)
        return vals["id"]

    def update(self, table, row_id, values, context):
        vals = {k: v for k, v in values.items() if k != "id"}
        if not vals:
            return
        if not self.apply:
            self.event("WOULD_UPDATE", table, rowId=row_id, **context)
            return

        sql = (
            f"UPDATE {q(table)} SET " +
            ", ".join(f"{q(k)}=%s" for k in vals) +
            ' WHERE "id"=%s'
        )
        with self.pg.cursor() as cur:
            cur.execute(sql, tuple(vals.values()) + (row_id,))
        self.event("UPDATE", table, rowId=row_id, **context)

    def load_profiles(self):
        ids = self.args.profile
        placeholders = ",".join(["%s"] * len(ids))
        with self.my.cursor() as cur:
            cur.execute(
                f"""
                SELECT *
                FROM profiles
                WHERE id IN ({placeholders})
                ORDER BY id
                """,
                tuple(ids),
            )
            self.profile_rows = cur.fetchall()

        found = {int(r["id"]) for r in self.profile_rows}
        missing = sorted(set(ids) - found)
        if missing:
            fail(f"OLD profile IDs not found: {missing}")

    def sync_professions(self):
        print("1/4 Checking Profession dependencies...")
        needed = sorted({
            int(p["profession_id"])
            for p in self.profile_rows
            if p.get("profession_id") is not None
        })

        for legacy_id in needed:
            existing = self.pg_one("Profession", {"legacyId": legacy_id})
            if existing and not existing.get("__multiple__"):
                self.event("KEEP_EXISTING", "Profession", legacyId=legacy_id, newId=existing["id"])
                continue

            with self.my.cursor() as cur:
                cur.execute("SELECT * FROM professions WHERE id=%s", (legacy_id,))
                old = cur.fetchone()

            if not old:
                self.event("OLD_REFERENCE_MISSING", "Profession", legacyId=legacy_id)
                continue

            with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    'SELECT * FROM "Profession" WHERE lower(name)=lower(%s) LIMIT 3',
                    (old["name"],),
                )
                same_name = [dict(r) for r in cur.fetchall()]

            if len(same_name) == 1:
                row = same_name[0]
                if row.get("legacyId") not in (None, legacy_id):
                    self.event(
                        "PROFESSION_NAME_CONFLICT", "Profession",
                        legacyId=legacy_id, existingLegacyId=row.get("legacyId"),
                        existingId=row["id"], name=old["name"]
                    )
                    continue

                if row.get("legacyId") is None:
                    self.update(
                        "Profession", row["id"],
                        {"legacyId": legacy_id},
                        {"legacyId": legacy_id, "name": old["name"], "reason": "exact_name_link"},
                    )
                self.event("PROFESSION_LINKED_BY_NAME", "Profession", legacyId=legacy_id, newId=row["id"])
                continue

            if len(same_name) > 1:
                self.event("PROFESSION_NAME_CONFLICT", "Profession", legacyId=legacy_id, name=old["name"])
                continue

            self.insert(
                "Profession",
                {
                    "legacyId": legacy_id,
                    "name": old["name"],
                    "createdAt": old.get("created_at") or datetime.now(),
                    "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.now(),
                },
                {"legacyId": legacy_id, "name": old["name"]},
            )

    def required_user_ids(self):
        out = set()
        for p in self.profile_rows:
            if p.get("user_id") is not None:
                out.add(int(p["user_id"]))
            if p.get("company_user_id") is not None:
                out.add(int(p["company_user_id"]))
        return sorted(out)

    def sync_users(self):
        print("2/4 Checking User dependencies...")
        for legacy_id in self.required_user_ids():
            existing = self.pg_one("User", {"legacyId": legacy_id})
            if existing and not existing.get("__multiple__"):
                self.user_map[legacy_id] = existing["id"]
                self.event("KEEP_EXISTING", "User", legacyId=legacy_id, newId=existing["id"])
                continue

            with self.my.cursor() as cur:
                cur.execute("""
                    SELECT
                        id, name, email, email_verified_at, status_id,
                        stripe_id, pm_type, pm_last_four, trial_ends_at,
                        created_by, created_at, updated_at
                    FROM users
                    WHERE id=%s
                """, (legacy_id,))
                old = cur.fetchone()

            if not old:
                self.event("OLD_USER_MISSING", "User", legacyId=legacy_id)
                continue

            email_matches = self.pg_email(old.get("email"))
            if len(email_matches) == 1:
                row = email_matches[0]
                if row.get("legacyId") not in (None, legacy_id):
                    self.event(
                        "USER_EMAIL_CONFLICT", "User",
                        legacyId=legacy_id, email=old.get("email"),
                        existingLegacyId=row.get("legacyId"), existingId=row["id"]
                    )
                    continue

                if row.get("legacyId") is None:
                    self.update(
                        "User", row["id"],
                        {"legacyId": legacy_id},
                        {"legacyId": legacy_id, "email": old.get("email"), "reason": "exact_email_link"},
                    )
                self.user_map[legacy_id] = row["id"]
                self.event("USER_LINKED_BY_EMAIL", "User", legacyId=legacy_id, newId=row["id"], email=old.get("email"))
                continue

            if len(email_matches) > 1:
                self.event("USER_EMAIL_CONFLICT", "User", legacyId=legacy_id, email=old.get("email"))
                continue

            if not old.get("email"):
                self.event("SKIP_USER_NO_EMAIL", "User", legacyId=legacy_id)
                continue

            values = {
                "email": old["email"],
                "password": None,  # intentionally never copy legacy password
                "name": old.get("name"),
                "createdAt": old.get("created_at") or datetime.now(),
                "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.now(),
                "isActive": bool(old.get("status_id") == 1),
                "isVerified": bool(old.get("email_verified_at")),
                "legacyId": legacy_id,
                "pmLastFour": old.get("pm_last_four"),
                "pmType": old.get("pm_type"),
                "stripeId": old.get("stripe_id"),
                "trialEndsAt": old.get("trial_ends_at"),
            }

            new_id = self.insert(
                "User", values,
                {"legacyId": legacy_id, "email": old["email"], "name": old.get("name")},
            )
            self.user_map[legacy_id] = new_id

    def package_maps(self):
        with self.my.cursor() as cur:
            cur.execute("SELECT * FROM packages ORDER BY id")
            old_packages = cur.fetchall()

        by_name = {norm_name(r.get("name")): r for r in old_packages}
        by_price = {
            r.get("stripe_price_id"): r
            for r in old_packages if r.get("stripe_price_id")
        }
        return by_name, by_price

    def sync_subscriptions(self):
        print("3/4 Checking Subscription dependencies...")
        required_users = self.required_user_ids()
        if not required_users:
            return

        placeholders = ",".join(["%s"] * len(required_users))
        with self.my.cursor() as cur:
            cur.execute(
                f"""
                SELECT *
                FROM subscriptions
                WHERE user_id IN ({placeholders})
                ORDER BY id
                """,
                tuple(required_users),
            )
            rows = cur.fetchall()

        by_name, by_price = self.package_maps()

        for old in rows:
            legacy_id = int(old["id"])
            old_user_id = int(old["user_id"])
            new_user_id = self.user_map.get(old_user_id)

            if not new_user_id:
                self.event(
                    "SKIP_SUBSCRIPTION_USER_MISSING", "Subscription",
                    legacyId=legacy_id, oldUserId=old_user_id
                )
                continue

            old_pkg = (
                by_price.get(old.get("stripe_price"))
                or by_name.get(norm_name(old.get("name")))
            )

            if not old_pkg:
                self.event(
                    "SKIP_SUBSCRIPTION_PACKAGE_UNKNOWN", "Subscription",
                    legacyId=legacy_id, name=old.get("name"),
                    stripePrice=old.get("stripe_price")
                )
                continue

            new_pkg = self.pg_one("Package", {"legacyId": int(old_pkg["id"])})
            if not new_pkg or new_pkg.get("__multiple__"):
                self.event(
                    "SKIP_NEW_PACKAGE_MISSING", "Subscription",
                    legacyId=legacy_id, packageLegacyId=int(old_pkg["id"])
                )
                continue

            existing = self.pg_one("Subscription", {"legacyId": legacy_id})

            values = {
                "userId": new_user_id,
                "packageId": new_pkg["id"],
                "name": (new_pkg.get("slug") or old_pkg.get("slug") or old.get("name") or "").strip(),
                "stripeId": old.get("stripe_id"),
                "stripeStatus": old.get("stripe_status"),
                "stripePrice": old.get("stripe_price"),
                "quantity": old.get("quantity"),
                "trialEndsAt": old.get("trial_ends_at"),
                # Preserve old ends_at semantics. current_period_end_at has no
                # direct column in the NEW Subscription schema.
                "endsAt": old.get("ends_at"),
                "provider": (new_pkg.get("slug") or "").strip() or old.get("provider"),
                "createdAt": old.get("created_at") or datetime.now(),
                "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.now(),
            }

            context = {
                "legacyId": legacy_id,
                "oldUserId": old_user_id,
                "packageLegacyId": int(old_pkg["id"]),
                "package": new_pkg.get("name"),
                "oldCurrentPeriodEndAt": old.get("current_period_end_at"),
            }

            if existing and not existing.get("__multiple__"):
                if old_newer(old.get("updated_at"), existing.get("updatedAt")):
                    self.update("Subscription", existing["id"], values, context)
                else:
                    self.event("KEEP_EXISTING", "Subscription", newId=existing["id"], **context)
            else:
                values["legacyId"] = legacy_id
                self.insert("Subscription", values, context)

    def inspect_subscription_items(self):
        print("4/4 Checking OLD SubscriptionItem children (report only)...")
        with self.my.cursor() as cur:
            cur.execute("SHOW TABLES LIKE 'subscription_items'")
            if not cur.fetchone():
                self.event("NO_OLD_SUBSCRIPTION_ITEMS_TABLE", "SubscriptionItem")
                return

            cur.execute("DESCRIBE subscription_items")
            cols = [r["Field"] for r in cur.fetchall()]

        required_users = self.required_user_ids()
        if not required_users:
            return

        placeholders = ",".join(["%s"] * len(required_users))
        with self.my.cursor() as cur:
            cur.execute(
                f"SELECT id FROM subscriptions WHERE user_id IN ({placeholders})",
                tuple(required_users),
            )
            sub_ids = [int(r["id"]) for r in cur.fetchall()]

        if not sub_ids:
            self.event("NO_OLD_SUBSCRIPTION_ITEMS", "SubscriptionItem")
            return

        if "subscription_id" not in cols:
            self.event(
                "SUBSCRIPTION_ITEMS_NEEDS_MANUAL_MAPPING", "SubscriptionItem",
                reason="old table has no subscription_id", columns=cols
            )
            return

        placeholders = ",".join(["%s"] * len(sub_ids))
        with self.my.cursor() as cur:
            cur.execute(
                f"SELECT * FROM subscription_items WHERE subscription_id IN ({placeholders})",
                tuple(sub_ids),
            )
            rows = cur.fetchall()

        if rows:
            self.event(
                "SUBSCRIPTION_ITEMS_PRESENT_NEEDS_MAPPING",
                "SubscriptionItem",
                count=len(rows),
                oldSubscriptionIds=sub_ids,
                columns=cols,
            )
        else:
            self.event("NO_OLD_SUBSCRIPTION_ITEMS", "SubscriptionItem", oldSubscriptionIds=sub_ids)

    def write_report(self):
        path = Path(self.args.report or (
            "/var/www/vbiz-me-backend/account-prep-report-" +
            datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"
        ))
        payload = {
            "mode": "APPLY" if self.apply else "DRY_RUN",
            "profiles": self.args.profile,
            "summary": dict(sorted(self.summary.items())),
            "events": self.events,
        }
        path.write_text(json.dumps(payload, indent=2, default=str))
        print("\n================ SUMMARY ================")
        for k, v in sorted(self.summary.items()):
            print(f"{k:42} {v}")
        print("=========================================")
        print("Report:", path)
        print("PostgreSQL changed." if self.apply else "DRY RUN ONLY — PostgreSQL was not changed.")

    def run(self):
        try:
            self.load_profiles()
            self.sync_professions()
            self.sync_users()
            self.sync_subscriptions()
            self.inspect_subscription_items()

            if self.apply:
                self.pg.commit()
            else:
                self.pg.rollback()

            self.write_report()
        except Exception:
            self.pg.rollback()
            raise
        finally:
            self.my.close()
            self.pg.close()


def parse_args():
    p = argparse.ArgumentParser()
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    p.add_argument("--profile", type=int, action="append", required=True)
    p.add_argument("--backups-confirmed", action="store_true")
    p.add_argument("--report")
    args = p.parse_args()
    if args.apply and not args.backups_confirmed:
        fail("--apply requires --backups-confirmed")
    return args


if __name__ == "__main__":
    Prep(parse_args()).run()
