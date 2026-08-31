#!/usr/bin/env python3
"""
vBiz Me OLD MySQL -> NEW PostgreSQL card synchronizer.

Safety model
------------
- NEW PostgreSQL schema is authoritative.
- OLD MySQL is read-only.
- DRY RUN by default.
- No DELETE/TRUNCATE/DROP.
- Existing NEW rows are updated only when OLD.updated_at is newer.
- NEW-only columns are never overwritten because only explicit legacy fields are mapped.
- Missing OLD rows are inserted into the existing NEW PostgreSQL tables.
- Matching uses legacyId / legacyServiceId / legacyPortfolioId / legacyPostId.
- Missing Profile rows are protected against duplicate slug/email collisions.
- Missing owner User rows are NOT created automatically.
- --apply requires --backups-confirmed.
"""

import argparse
import json
import os
import re
import sys
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pymysql
import psycopg2
from psycopg2.extras import Json, RealDictCursor


POST_TYPE_DESTINATIONS = {
    6:  ["Blog", "BlogDirect"],
    7:  ["GeneralPost"],
    8:  ["BBBAccreditation"],
    9:  ["Licensing"],
    10: ["DCP"],
    11: ["CertificateLicense"],
    12: ["InsuranceLicense"],
    13: ["Faq"],
    14: ["CalendarSection"],
    15: ["PropertyListing"],
    16: ["AboutMe", "AboutMeDirect"],
    17: ["Event"],
    18: ["MediaPress"],
    19: ["MissionStatement"],
    20: ["VideoExplainer"],
    21: ["MenuSection"],
    22: ["WhyChooseUs"],
    23: ["AnnouncementDirect"],
    24: ["JoinMyTeam"],
    25: ["Booking"],
    26: ["AdditionalService"],
    27: ["VideoLink"],
    28: ["Inventory"],
    29: ["HomeSolar"],
    30: ["ResiliencyProduct"],
    31: ["Breakfast"],
    32: ["Lunch"],
    33: ["Dinner"],
    34: ["Product"],
    35: ["SalesPerson"],
    36: ["TeamMember"],
}

# Based on the existing migrated data, Blog and About Me are direct sections
# rather than TabItem-backed sections.
TABITEM_EXCLUDE = {6, 16}

REFERENCE_TABLES = {
    "profession_id": "Profession",
    "gender_id": "Gender",
    "marital_status_id": "MaritalStatus",
}


def die(msg: str, code: int = 2) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(code)


def qident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def mysql_ident(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def norm_dt(v: Any) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        if getattr(v, "tzinfo", None):
            return v.replace(tzinfo=None)
        return v
    return None


def old_is_newer(old_updated: Any, new_updated: Any) -> bool:
    old_dt = norm_dt(old_updated)
    new_dt = norm_dt(new_updated)
    if old_dt is None:
        return False
    if new_dt is None:
        return True
    return old_dt > new_dt


def cuid_like() -> str:
    # 25-char CUID-shaped identifier. PostgreSQL columns are TEXT and Prisma
    # does not enforce a CUID regex when an explicit ID is provided.
    return "c" + uuid.uuid4().hex[:24]


def slugify(v: Optional[str]) -> str:
    s = (v or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "section"


def parse_jsonish(v: Any) -> Any:
    if v is None or isinstance(v, (dict, list, int, float, bool)):
        return v
    if isinstance(v, str):
        t = v.strip()
        if not t:
            return None
        try:
            return json.loads(t)
        except Exception:
            return {"legacyRaw": v}
    return {"legacyRaw": str(v)}


class Sync:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.apply = bool(args.apply)
        self.events: List[Dict[str, Any]] = []
        self.summary = Counter()
        self.schema_cache: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.status_cache: Dict[str, List[Any]] = {}
        self.mode_cache: Dict[Tuple[str, str], Any] = {}
        self.profile_map: Dict[int, str] = {}
        self.user_map: Dict[int, Optional[str]] = {}
        self.ref_map: Dict[Tuple[str, int], Optional[str]] = {}
        self.post_map: Dict[int, str] = {}
        self.post_types: Dict[int, Dict[str, Any]] = {}

        required = [
            "OLD_MYSQL_HOST", "OLD_MYSQL_USER", "OLD_MYSQL_PASSWORD",
            "OLD_MYSQL_DATABASE", "NEW_DATABASE_URL",
        ]
        missing = [x for x in required if not os.environ.get(x)]
        if missing:
            die("Missing environment variables: " + ", ".join(missing))

        self.mysql = pymysql.connect(
            host=os.environ["OLD_MYSQL_HOST"],
            port=int(os.environ.get("OLD_MYSQL_PORT", "3306")),
            user=os.environ["OLD_MYSQL_USER"],
            password=os.environ["OLD_MYSQL_PASSWORD"],
            database=os.environ["OLD_MYSQL_DATABASE"],
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
        )

        # Remove Prisma-only query parameter if it accidentally remains.
        pg_url = os.environ["NEW_DATABASE_URL"]
        pg_url = re.sub(r"([?&])schema=public(?:&|$)", lambda m: "?" if m.group(1) == "?" else "", pg_url)
        pg_url = pg_url.rstrip("?&")
        self.pg = psycopg2.connect(pg_url)
        self.pg.autocommit = False

        with self.pg.cursor() as cur:
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")

    def close(self):
        try:
            if self.apply:
                self.pg.commit()
            else:
                self.pg.rollback()
        finally:
            try:
                self.mysql.close()
            finally:
                self.pg.close()

    def event(self, action: str, table: str, **details: Any) -> None:
        clean = {"action": action, "table": table}
        for k, v in details.items():
            if isinstance(v, (datetime, date)):
                clean[k] = v.isoformat()
            else:
                clean[k] = v
        self.events.append(clean)
        self.summary[action] += 1

    def table_exists(self, table: str) -> bool:
        with self.pg.cursor() as cur:
            cur.execute("""
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema='public' AND table_name=%s
            """, (table,))
            return cur.fetchone() is not None

    def columns(self, table: str) -> Dict[str, Dict[str, Any]]:
        if table in self.schema_cache:
            return self.schema_cache[table]
        with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT
                    column_name,
                    data_type,
                    is_nullable,
                    column_default
                FROM information_schema.columns
                WHERE table_schema='public' AND table_name=%s
                ORDER BY ordinal_position
            """, (table,))
            rows = cur.fetchall()
        cols = {
            r["column_name"]: {
                "data_type": r["data_type"],
                "nullable": r["is_nullable"] == "YES",
                "default": r["column_default"],
            }
            for r in rows
        }
        self.schema_cache[table] = cols
        return cols

    def required_missing(self, table: str, values: Dict[str, Any]) -> List[str]:
        cols = self.columns(table)
        missing = []
        for name, meta in cols.items():
            if meta["nullable"] or meta["default"] is not None:
                continue
            if name not in values or values[name] is None:
                missing.append(name)
        return missing

    def adapt_values(self, table: str, values: Dict[str, Any]) -> Dict[str, Any]:
        cols = self.columns(table)
        out = {}
        for k, v in values.items():
            if k not in cols:
                continue
            dtype = cols[k]["data_type"]
            if dtype in ("json", "jsonb") and v is not None:
                out[k] = Json(v)
            else:
                out[k] = v
        return out

    def find_one(self, table: str, where: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not self.table_exists(table):
            return None
        cols = self.columns(table)
        where = {k: v for k, v in where.items() if k in cols}
        if not where:
            return None
        sql = (
            f"SELECT * FROM {qident(table)} WHERE " +
            " AND ".join(f"{qident(k)}=%s" for k in where) +
            " LIMIT 2"
        )
        with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, tuple(where.values()))
            rows = cur.fetchall()
        if len(rows) > 1:
            return {"__multiple__": True}
        return dict(rows[0]) if rows else None

    def find_ci(self, table: str, column: str, value: Optional[str]) -> List[Dict[str, Any]]:
        if not value or not self.table_exists(table) or column not in self.columns(table):
            return []
        with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"SELECT * FROM {qident(table)} "
                f"WHERE lower({qident(column)})=lower(%s) LIMIT 3",
                (value,),
            )
            return [dict(r) for r in cur.fetchall()]

    def insert(self, table: str, values: Dict[str, Any], *, context: Dict[str, Any]) -> Optional[str]:
        if not self.table_exists(table):
            self.event("SKIP_TABLE_MISSING", table, **context)
            return None
        vals = dict(values)
        cols = self.columns(table)
        if "id" in cols and not vals.get("id"):
            vals["id"] = cuid_like()
        vals = {k: v for k, v in vals.items() if k in cols}
        missing = self.required_missing(table, vals)
        if missing:
            self.event("SKIP_REQUIRED_COLUMNS", table, missing=missing, **context)
            return None
        new_id = vals.get("id")
        if not self.apply:
            self.event("WOULD_INSERT", table, newId=new_id, **context)
            return new_id
        adapted = self.adapt_values(table, vals)
        sql = (
            f"INSERT INTO {qident(table)} (" +
            ", ".join(qident(k) for k in adapted) +
            ") VALUES (" +
            ", ".join(["%s"] * len(adapted)) +
            ")"
        )
        try:
            with self.pg.cursor() as cur:
                cur.execute(sql, tuple(adapted.values()))
            self.event("INSERT", table, newId=new_id, **context)
            return new_id
        except Exception as e:
            self.pg.rollback()
            # Restart a transaction after rollback.
            self.event("ERROR_INSERT", table, error=str(e)[:500], **context)
            return None

    def update(self, table: str, row_id: Any, values: Dict[str, Any], *, context: Dict[str, Any]) -> bool:
        if not self.table_exists(table):
            self.event("SKIP_TABLE_MISSING", table, **context)
            return False
        protected = {
            "id", "profileId", "legacyId", "legacyServiceId",
            "legacyPortfolioId", "legacyPostId", "legacyPostTypeId",
            "createdAt",
        }
        vals = {
            k: v for k, v in values.items()
            if k in self.columns(table) and k not in protected
        }
        if not vals:
            self.event("KEEP_NEW", table, reason="no_mapped_update_fields", **context)
            return False
        if not self.apply:
            self.event("WOULD_UPDATE_FROM_OLD", table, rowId=row_id, **context)
            return True
        adapted = self.adapt_values(table, vals)
        sql = (
            f"UPDATE {qident(table)} SET " +
            ", ".join(f"{qident(k)}=%s" for k in adapted) +
            f" WHERE {qident('id')}=%s"
        )
        try:
            with self.pg.cursor() as cur:
                cur.execute(sql, tuple(adapted.values()) + (row_id,))
            self.event("UPDATE_FROM_OLD", table, rowId=row_id, **context)
            return True
        except Exception as e:
            self.pg.rollback()
            self.event("ERROR_UPDATE", table, error=str(e)[:500], **context)
            return False

    def mode(self, table: str, column: str, fallback: Any = None) -> Any:
        key = (table, column)
        if key in self.mode_cache:
            return self.mode_cache[key]
        if not self.table_exists(table) or column not in self.columns(table):
            self.mode_cache[key] = fallback
            return fallback
        with self.pg.cursor() as cur:
            cur.execute(
                f"SELECT {qident(column)}, COUNT(*) c "
                f"FROM {qident(table)} "
                f"WHERE {qident(column)} IS NOT NULL "
                f"GROUP BY {qident(column)} ORDER BY c DESC LIMIT 1"
            )
            r = cur.fetchone()
        value = r[0] if r else fallback
        self.mode_cache[key] = value
        return value

    def text_status(self, table: str, source_status: Any) -> str:
        if table not in self.status_cache:
            if self.table_exists(table) and "status" in self.columns(table):
                with self.pg.cursor() as cur:
                    cur.execute(
                        f"SELECT DISTINCT {qident('status')} "
                        f"FROM {qident(table)} "
                        f"WHERE {qident('status')} IS NOT NULL LIMIT 20"
                    )
                    self.status_cache[table] = [r[0] for r in cur.fetchall()]
            else:
                self.status_cache[table] = []
        vals = self.status_cache[table]
        active = str(source_status).lower() in {"1", "true", "active", "yes"}
        strvals = [str(v) for v in vals]
        if any(v == "ACTIVE" for v in strvals):
            return "ACTIVE" if active else "INACTIVE"
        if any(v == "active" for v in strvals):
            return "active" if active else "inactive"
        if any(v == "1" for v in strvals):
            return "1" if active else "0"
        return "ACTIVE" if active else "INACTIVE"

    def resolve_user(self, legacy_user_id: Optional[int], email: Optional[str] = None) -> Optional[str]:
        if legacy_user_id is None:
            return None
        if legacy_user_id in self.user_map:
            return self.user_map[legacy_user_id]
        row = self.find_one("User", {"legacyId": legacy_user_id})
        if row and not row.get("__multiple__"):
            self.user_map[legacy_user_id] = row["id"]
            return row["id"]
        matches = self.find_ci("User", "email", email)
        if len(matches) == 1:
            self.event(
                "USER_MATCH_BY_EMAIL", "User",
                legacyUserId=legacy_user_id, newUserId=matches[0]["id"]
            )
            self.user_map[legacy_user_id] = matches[0]["id"]
            return matches[0]["id"]
        self.user_map[legacy_user_id] = None
        return None

    def resolve_ref(self, table: str, legacy_id: Optional[int]) -> Optional[str]:
        if legacy_id is None:
            return None
        key = (table, legacy_id)
        if key in self.ref_map:
            return self.ref_map[key]
        row = self.find_one(table, {"legacyId": legacy_id})
        out = None if not row or row.get("__multiple__") else row.get("id")
        self.ref_map[key] = out
        if out is None:
            self.event("REFERENCE_MISSING", table, legacyId=legacy_id)
        return out

    def load_post_types(self):
        with self.mysql.cursor() as cur:
            cur.execute("SELECT id, name, title FROM post_types ORDER BY id")
            self.post_types = {r["id"]: r for r in cur.fetchall()}

    def wanted_profile(self, legacy_id: int) -> bool:
        if self.args.profile and legacy_id not in self.args.profile:
            return False
        if legacy_id in self.args.exclude_profile:
            return False
        return True

    def profile_defaults(self) -> Dict[str, Any]:
        return {
            "isPublic": bool(self.mode("Profile", "isPublic", True)),
            "isDraft": bool(self.mode("Profile", "isDraft", False)),
            "template": self.mode("Profile", "template", "default") or "default",
        }

    def sync_profiles(self):
        print("1/8 Syncing Profile rows...")
        defaults = self.profile_defaults()
        with self.mysql.cursor() as cur:
            cur.execute("""
                SELECT *
                FROM profiles
                ORDER BY id
            """)
            rows = cur.fetchall()

        for old in rows:
            legacy_id = int(old["id"])
            if not self.wanted_profile(legacy_id):
                continue

            existing = self.find_one("Profile", {"legacyId": legacy_id})

            old_user_email = old.get("email")
            user_id = self.resolve_user(old.get("user_id"), old_user_email)
            company_user_id = self.resolve_user(old.get("company_user_id"), old_user_email)

            profession_id = self.resolve_ref("Profession", old.get("profession_id"))
            gender_id = self.resolve_ref("Gender", old.get("gender_id"))
            marital_id = self.resolve_ref("MaritalStatus", old.get("marital_status_id"))

            mapped = {
                "legacyId": legacy_id,
                "userId": user_id,
                "companyUserId": company_user_id,
                "professionId": profession_id,
                "genderId": gender_id,
                "maritalStatusId": marital_id,
                "name": old.get("name") or "Unnamed",
                "slug": old.get("slug"),
                "prof": old.get("prof"),
                "companyName": old.get("company_name"),
                "email": old.get("email") or "",
                "website": old.get("website"),
                "lastName": old.get("last_name"),
                "dob": old.get("dob"),
                "phone": old.get("phone"),
                "whatsapp": old.get("whatsapp"),
                "countryCode": old.get("country_code"),
                "facebook": old.get("facebook"),
                "instagram": old.get("instagram"),
                "twitter": old.get("twitter"),
                "tiktok": old.get("tiktok"),
                "youtube": old.get("youtube"),
                "rumble": old.get("rumble"),
                "truth": old.get("truth"),
                "linkedin": old.get("linkedin"),
                "avatar": old.get("avatar"),
                "colorCode": old.get("color_code") or "#000000",
                "address": old.get("address"),
                "about": old.get("about"),
                "isEmploy": bool(old.get("is_employ")),
                "designation": old.get("designation"),
                "referralCount": int(old.get("referral_count") or 0),
                "referralCode": old.get("referral_code"),
                "createdAt": old.get("created_at") or datetime.utcnow(),
                "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
            }

            context = {
                "legacyId": legacy_id,
                "slug": old.get("slug"),
            }

            if existing and not existing.get("__multiple__"):
                self.profile_map[legacy_id] = existing["id"]
                if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                    # Do not null existing relationships merely because a legacy
                    # reference is missing from the NEW reference tables.
                    for key in ("userId", "companyUserId", "professionId", "genderId", "maritalStatusId"):
                        if mapped.get(key) is None:
                            mapped.pop(key, None)
                    self.update("Profile", existing["id"], mapped, context=context)
                else:
                    self.event("KEEP_NEW", "Profile", reason="new_not_older", **context)
                continue

            # Never auto-insert a legacy profile if a NEW-system profile already
            # uses the same slug or email; that could duplicate a new-only card.
            slug_matches = self.find_ci("Profile", "slug", old.get("slug"))
            email_matches = self.find_ci("Profile", "email", old.get("email"))
            possible = {
                r["id"]: r for r in (slug_matches + email_matches)
                if r.get("legacyId") != legacy_id
            }
            if possible:
                self.event(
                    "PROFILE_POSSIBLE_EXISTING_CONFLICT", "Profile",
                    possibleNewIds=sorted(possible.keys()), **context
                )
                continue

            if old.get("user_id") and user_id is None and not self.args.allow_ownerless:
                self.event(
                    "SKIP_OWNER_USER_MISSING", "Profile",
                    legacyUserId=old.get("user_id"), **context
                )
                continue

            mapped.update({
                "isPublic": defaults["isPublic"],
                "viewCount": 0,
                "template": defaults["template"],
                "themeConfig": None,
                "isDraft": defaults["isDraft"],
            })
            new_id = self.insert("Profile", mapped, context=context)
            if new_id:
                self.profile_map[legacy_id] = new_id

        # Include all already-existing mapped profiles, even if they were excluded
        # from profile updates, so child records can resolve their parent.
        with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute('SELECT id, "legacyId" FROM "Profile" WHERE "legacyId" IS NOT NULL')
            for r in cur.fetchall():
                self.profile_map.setdefault(int(r["legacyId"]), r["id"])

    def sync_settings(self):
        print("2/8 Syncing Setting / ProfileSetting / Contact rows...")

        with self.mysql.cursor() as cur:
            cur.execute("SELECT * FROM settings ORDER BY id")
            rows = cur.fetchall()

        for old in rows:
            pid = old.get("profile_id")
            if pid is None or not self.wanted_profile(int(pid)):
                continue
            new_pid = self.profile_map.get(int(pid))
            if not new_pid:
                self.event("SKIP_PARENT_PROFILE_MISSING", "Setting", legacyId=old["id"], profileLegacyId=pid)
                continue

            existing = self.find_one("Setting", {"legacyId": int(old["id"])})
            values = {
                "legacyId": int(old["id"]),
                "profileId": new_pid,
                "key": old.get("key") or "",
                "value": old.get("value"),
                "createdAt": old.get("created_at") or datetime.utcnow(),
                "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
            }
            context = {"legacyId": int(old["id"]), "profileLegacyId": int(pid), "key": old.get("key")}

            if existing and not existing.get("__multiple__"):
                if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                    self.update("Setting", existing["id"], values, context=context)
                else:
                    self.event("KEEP_NEW", "Setting", reason="new_not_older", **context)
                continue

            # Same profile/key without legacyId: treat as the same semantic setting
            # but never overwrite a newer NEW value.
            same_key = self.find_one("Setting", {"profileId": new_pid, "key": old.get("key")})
            if same_key and not same_key.get("__multiple__"):
                if same_key.get("legacyId") in (None, int(old["id"])):
                    if self.apply and same_key.get("legacyId") is None:
                        with self.pg.cursor() as cur:
                            cur.execute(
                                'UPDATE "Setting" SET "legacyId"=%s WHERE id=%s',
                                (int(old["id"]), same_key["id"]),
                            )
                        self.event("LINK_LEGACY_ID", "Setting", rowId=same_key["id"], **context)
                    else:
                        self.event("WOULD_LINK_LEGACY_ID", "Setting", rowId=same_key["id"], **context)
                    if old_is_newer(old.get("updated_at"), same_key.get("updatedAt")):
                        self.update("Setting", same_key["id"], values, context=context)
                    else:
                        self.event("KEEP_NEW", "Setting", reason="same_key_new_not_older", **context)
                    continue
                self.event("SETTING_KEY_CONFLICT", "Setting", rowId=same_key["id"], **context)
                continue
            if same_key and same_key.get("__multiple__"):
                self.event("SETTING_KEY_CONFLICT", "Setting", reason="multiple_rows", **context)
                continue

            self.insert("Setting", values, context=context)

        if self.table_exists("ProfileSetting"):
            with self.mysql.cursor() as cur:
                cur.execute("SELECT * FROM profile_settings ORDER BY id")
                rows = cur.fetchall()
            for old in rows:
                pid = old.get("profile_id")
                if pid is None or not self.wanted_profile(int(pid)):
                    continue
                new_pid = self.profile_map.get(int(pid))
                if not new_pid:
                    self.event("SKIP_PARENT_PROFILE_MISSING", "ProfileSetting", legacyId=old["id"], profileLegacyId=pid)
                    continue
                existing = self.find_one("ProfileSetting", {"legacyId": int(old["id"])})
                values = {
                    "legacyId": int(old["id"]),
                    "profileId": new_pid,
                    "profileTemplate": old.get("profile_template") or self.mode("ProfileSetting", "profileTemplate", "default"),
                    "layoutStyle": old.get("layout_style"),
                    "buttonStyle": old.get("button_style"),
                    "cornerStyle": old.get("corner_style"),
                    "themeConfig": parse_jsonish(old.get("theme_config")),
                    "createdAt": old.get("created_at") or datetime.utcnow(),
                    "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
                }
                context = {"legacyId": int(old["id"]), "profileLegacyId": int(pid)}
                if existing and not existing.get("__multiple__"):
                    if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                        self.update("ProfileSetting", existing["id"], values, context=context)
                    else:
                        self.event("KEEP_NEW", "ProfileSetting", reason="new_not_older", **context)
                else:
                    same_profile = self.find_one("ProfileSetting", {"profileId": new_pid})
                    if same_profile:
                        self.event("PROFILE_SETTING_CONFLICT", "ProfileSetting", **context)
                    else:
                        self.insert("ProfileSetting", values, context=context)

        if self.table_exists("Contact"):
            with self.mysql.cursor() as cur:
                cur.execute("SELECT * FROM contacts ORDER BY id")
                rows = cur.fetchall()
            for old in rows:
                pid = old.get("profile_id")
                if pid is None or not self.wanted_profile(int(pid)):
                    continue
                new_pid = self.profile_map.get(int(pid))
                if not new_pid:
                    continue
                existing = self.find_one("Contact", {"legacyId": int(old["id"])})
                values = {
                    "legacyId": int(old["id"]),
                    "profileId": new_pid,
                    "name": old.get("name"),
                    "email": old.get("email"),
                    "phone": old.get("phone"),
                    "message": old.get("detail"),
                    "meta": {"isRead": bool(old.get("is_read"))},
                    "createdAt": old.get("created_at") or datetime.utcnow(),
                    "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
                }
                context = {"legacyId": int(old["id"]), "profileLegacyId": int(pid)}
                if existing and not existing.get("__multiple__"):
                    if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                        self.update("Contact", existing["id"], values, context=context)
                    else:
                        self.event("KEEP_NEW", "Contact", reason="new_not_older", **context)
                else:
                    self.insert("Contact", values, context=context)

    def sync_services(self):
        print("3/8 Syncing Service / Client / Review rows...")
        rating_default = int(self.mode("Review", "rating", 5) or 5)

        with self.mysql.cursor() as cur:
            cur.execute("SELECT * FROM services ORDER BY id")
            rows = cur.fetchall()

        for old in rows:
            pid = old.get("profile_id")
            if pid is None or not self.wanted_profile(int(pid)):
                continue
            new_pid = self.profile_map.get(int(pid))
            if not new_pid:
                self.event("SKIP_PARENT_PROFILE_MISSING", "services", legacyId=old["id"], profileLegacyId=pid)
                continue

            pt = int(old.get("post_type_id") or 0)
            legacy_id = int(old["id"])
            common_context = {"legacyId": legacy_id, "profileLegacyId": int(pid), "postTypeId": pt}

            if pt == 1:
                table, legacy_col = "Service", "legacyId"
                values = {
                    legacy_col: legacy_id,
                    "profileId": new_pid,
                    "title": old.get("title"),
                    "description": old.get("description"),
                    "status": int(bool(old.get("status"))),
                    "sortOrder": 0,
                    "createdAt": old.get("created_at") or datetime.utcnow(),
                    "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
                }
            elif pt == 2:
                table, legacy_col = "Client", "legacyServiceId"
                values = {
                    legacy_col: legacy_id,
                    "profileId": new_pid,
                    "legacyPostTypeId": pt,
                    "title": old.get("title"),
                    "description": old.get("description"),
                    "status": self.text_status(table, old.get("status")),
                    "sortOrder": 0,
                    "createdAt": old.get("created_at") or datetime.utcnow(),
                    "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
                }
            elif pt == 3:
                table, legacy_col = "Review", "legacyServiceId"
                values = {
                    legacy_col: legacy_id,
                    "profileId": new_pid,
                    "author": old.get("title"),
                    "text": old.get("description"),
                    "rating": rating_default,
                    "status": int(bool(old.get("status"))),
                    "sortOrder": 0,
                    "createdAt": old.get("created_at") or datetime.utcnow(),
                    "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
                }
            else:
                self.event("SKIP_UNKNOWN_SERVICE_POST_TYPE", "services", **common_context)
                continue

            existing = self.find_one(table, {legacy_col: legacy_id})
            if existing and not existing.get("__multiple__"):
                if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                    self.update(table, existing["id"], values, context=common_context)
                else:
                    self.event("KEEP_NEW", table, reason="new_not_older", **common_context)
            else:
                self.insert(table, values, context=common_context)

    def sync_portfolios(self):
        print("4/8 Syncing Portfolio / Gallery / Video rows...")
        with self.mysql.cursor() as cur:
            cur.execute("SELECT * FROM portfolios ORDER BY id")
            rows = cur.fetchall()

        for old in rows:
            pid = old.get("profile_id")
            if pid is None or not self.wanted_profile(int(pid)):
                continue
            new_pid = self.profile_map.get(int(pid))
            if not new_pid:
                self.event("SKIP_PARENT_PROFILE_MISSING", "portfolios", legacyId=old["id"], profileLegacyId=pid)
                continue

            legacy_id = int(old["id"])
            pt = int(old.get("post_type_id") or 0)
            context = {"legacyId": legacy_id, "profileLegacyId": int(pid), "postTypeId": pt}

            # The original migration keeps a legacy Portfolio representation.
            p_values = {
                "legacyId": legacy_id,
                "profileId": new_pid,
                "title": old.get("title"),
                "description": old.get("description"),
                "status": int(bool(old.get("status"))),
                "sortOrder": 0,
                "url": old.get("url"),
                "createdAt": old.get("created_at") or datetime.utcnow(),
                "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
            }
            existing = self.find_one("Portfolio", {"legacyId": legacy_id})
            if existing and not existing.get("__multiple__"):
                if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                    self.update("Portfolio", existing["id"], p_values, context=context)
                else:
                    self.event("KEEP_NEW", "Portfolio", reason="new_not_older", **context)
            else:
                self.insert("Portfolio", p_values, context=context)

            direct_table = "Gallery" if pt == 4 else "Video" if pt == 5 else None
            if direct_table:
                d_values = {
                    "legacyPortfolioId": legacy_id,
                    "legacyPostTypeId": pt,
                    "profileId": new_pid,
                    "title": old.get("title"),
                    "description": old.get("description"),
                    "url": old.get("url"),
                    "status": self.text_status(direct_table, old.get("status")),
                    "sortOrder": 0,
                    "createdAt": old.get("created_at") or datetime.utcnow(),
                    "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
                }
                existing_d = self.find_one(direct_table, {"legacyPortfolioId": legacy_id})
                if existing_d and not existing_d.get("__multiple__"):
                    if old_is_newer(old.get("updated_at"), existing_d.get("updatedAt")):
                        self.update(direct_table, existing_d["id"], d_values, context=context)
                    else:
                        self.event("KEEP_NEW", direct_table, reason="new_not_older", **context)
                else:
                    self.insert(direct_table, d_values, context=context)

    def post_meta_for(self, post_id: int) -> Dict[str, Any]:
        with self.mysql.cursor() as cur:
            cur.execute(
                "SELECT `key`, value FROM post_metas WHERE post_id=%s ORDER BY id",
                (post_id,),
            )
            rows = cur.fetchall()
        out: Dict[str, Any] = {}
        for r in rows:
            k = r.get("key") or ""
            v = r.get("value")
            if k in out:
                if not isinstance(out[k], list):
                    out[k] = [out[k]]
                out[k].append(v)
            else:
                out[k] = v
        return out

    def featured_from_meta(self, metas: Dict[str, Any]) -> Optional[str]:
        preferred = [
            "featured_image", "featuredImage", "image", "image_url",
            "imageUrl", "photo", "thumbnail", "thumbnail_url",
        ]
        for k in preferred:
            v = metas.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for k, v in metas.items():
            lk = k.lower()
            if any(x in lk for x in ("image", "photo", "thumbnail")) and isinstance(v, str) and v.strip():
                return v.strip()
        return None

    def post_type_ref(self, legacy_post_type_id: int) -> Optional[str]:
        return self.resolve_ref("PostType", legacy_post_type_id)

    def user_ref_for_post(self, legacy_user_id: Optional[int]) -> Optional[str]:
        if legacy_user_id is None:
            return None
        return self.resolve_user(int(legacy_user_id), None)

    def generic_post_values(self, old: Dict[str, Any], new_pid: str) -> Dict[str, Any]:
        pt = int(old.get("post_type_id") or 0)
        values = {
            "legacyId": int(old["id"]),
            "profileId": new_pid,
            "postTypeId": self.post_type_ref(pt),
            "title": old.get("title"),
            "slug": old.get("slug"),
            "excerpt": old.get("excerpt"),
            "content": old.get("content"),
            "order": int(old.get("order") or 0),
            "sortOrder": int(old.get("order") or 0),
            "date": old.get("date"),
            "status": self.text_status("Post", old.get("status")),
            "url": old.get("url"),
            "createdById": self.user_ref_for_post(old.get("created_by")),
            "updatedById": self.user_ref_for_post(old.get("updated_by")),
            "deletedById": self.user_ref_for_post(old.get("deleted_by")),
            "deletedAt": old.get("deleted_at"),
            "createdAt": old.get("created_at") or datetime.utcnow(),
            "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
        }
        return values

    def sync_generic_post(self, old: Dict[str, Any], new_pid: str) -> Optional[str]:
        if not self.table_exists("Post"):
            return None
        legacy_id = int(old["id"])
        context = {
            "legacyId": legacy_id,
            "profileLegacyId": int(old["profile_id"]),
            "postTypeId": int(old.get("post_type_id") or 0),
        }
        values = self.generic_post_values(old, new_pid)
        existing = self.find_one("Post", {"legacyId": legacy_id})
        if existing and not existing.get("__multiple__"):
            self.post_map[legacy_id] = existing["id"]
            if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                self.update("Post", existing["id"], values, context=context)
            else:
                self.event("KEEP_NEW", "Post", reason="new_not_older", **context)
            return existing["id"]
        new_id = self.insert("Post", values, context=context)
        if new_id:
            self.post_map[legacy_id] = new_id
        return new_id

    def infer_tab_key(self, post_type_id: int) -> str:
        if self.table_exists("TabItem") and "legacyPostTypeId" in self.columns("TabItem"):
            with self.pg.cursor() as cur:
                cur.execute(
                    'SELECT "tabKey", COUNT(*) c FROM "TabItem" '
                    'WHERE "legacyPostTypeId"=%s AND "tabKey" IS NOT NULL '
                    'GROUP BY "tabKey" ORDER BY c DESC LIMIT 1',
                    (post_type_id,),
                )
                r = cur.fetchone()
                if r and r[0]:
                    return r[0]
        pt = self.post_types.get(post_type_id, {})
        return slugify(pt.get("name") or pt.get("title") or f"post-{post_type_id}")

    def sync_direct_post(self, table: str, old: Dict[str, Any], new_pid: str, metas: Dict[str, Any]):
        legacy_id = int(old["id"])
        pt = int(old.get("post_type_id") or 0)
        context = {
            "legacyId": legacy_id,
            "profileLegacyId": int(old["profile_id"]),
            "postTypeId": pt,
        }
        description = old.get("content") if old.get("content") not in (None, "") else old.get("excerpt")
        values = {
            "legacyPostId": legacy_id,
            "legacyPostTypeId": pt,
            "profileId": new_pid,
            "title": old.get("title"),
            "description": description,
            "url": old.get("url"),
            "featuredImage": self.featured_from_meta(metas),
            "status": self.text_status(table, old.get("status")),
            "sortOrder": int(old.get("order") or 0),
            "deletedAt": old.get("deleted_at"),
            "createdAt": old.get("created_at") or datetime.utcnow(),
            "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
            "metas": metas or None,
            "date": old.get("date").isoformat() if isinstance(old.get("date"), date) else old.get("date"),
        }

        legacy_col = "legacyPostId"
        if legacy_col not in self.columns(table):
            self.event("SKIP_NO_LEGACY_POST_COLUMN", table, **context)
            return

        existing = self.find_one(table, {legacy_col: legacy_id})
        if existing and not existing.get("__multiple__"):
            if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                self.update(table, existing["id"], values, context=context)
            else:
                self.event("KEEP_NEW", table, reason="new_not_older", **context)
        else:
            self.insert(table, values, context=context)

    def sync_tabitem(self, old: Dict[str, Any], new_pid: str, metas: Dict[str, Any]):
        if not self.table_exists("TabItem"):
            return
        pt = int(old.get("post_type_id") or 0)
        if pt in TABITEM_EXCLUDE:
            return
        legacy_id = int(old["id"])
        context = {"legacyId": legacy_id, "profileLegacyId": int(old["profile_id"]), "postTypeId": pt}
        description = old.get("content") if old.get("content") not in (None, "") else old.get("excerpt")
        values = {
            "legacyPostId": legacy_id,
            "legacyPostTypeId": pt,
            "profileId": new_pid,
            "tabKey": self.infer_tab_key(pt),
            "title": old.get("title"),
            "description": description,
            "url": old.get("url"),
            "featuredImage": self.featured_from_meta(metas),
            "status": self.text_status("TabItem", old.get("status")),
            "sortOrder": int(old.get("order") or 0),
            "metas": metas or None,
            "deletedAt": old.get("deleted_at"),
            "createdAt": old.get("created_at") or datetime.utcnow(),
            "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
        }
        existing = self.find_one("TabItem", {"legacyPostId": legacy_id})
        if existing and not existing.get("__multiple__"):
            if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                self.update("TabItem", existing["id"], values, context=context)
            else:
                self.event("KEEP_NEW", "TabItem", reason="new_not_older", **context)
        elif existing and existing.get("__multiple__"):
            self.event("TABITEM_CONFLICT", "TabItem", reason="multiple_legacy_rows", **context)
        else:
            self.insert("TabItem", values, context=context)

    def sync_posts(self):
        print("5/8 Syncing Post + direct section + TabItem rows...")
        with self.mysql.cursor() as cur:
            cur.execute("SELECT * FROM posts ORDER BY id")
            rows = cur.fetchall()

        for old in rows:
            pid = old.get("profile_id")
            if pid is None or not self.wanted_profile(int(pid)):
                continue
            new_pid = self.profile_map.get(int(pid))
            if not new_pid:
                self.event("SKIP_PARENT_PROFILE_MISSING", "posts", legacyId=old["id"], profileLegacyId=pid)
                continue

            pt = int(old.get("post_type_id") or 0)
            metas = self.post_meta_for(int(old["id"]))

            self.sync_generic_post(old, new_pid)

            for table in POST_TYPE_DESTINATIONS.get(pt, []):
                if self.table_exists(table):
                    self.sync_direct_post(table, old, new_pid, metas)
                else:
                    self.event(
                        "SKIP_TABLE_MISSING", table,
                        legacyId=int(old["id"]), profileLegacyId=int(pid), postTypeId=pt
                    )

            if pt not in POST_TYPE_DESTINATIONS:
                self.event(
                    "UNKNOWN_POST_TYPE", "posts",
                    legacyId=int(old["id"]), profileLegacyId=int(pid), postTypeId=pt
                )

            self.sync_tabitem(old, new_pid, metas)

    def sync_post_metas(self):
        print("6/8 Syncing PostMeta rows where the NEW Post model supports them...")
        if not self.table_exists("PostMeta"):
            return
        with self.mysql.cursor() as cur:
            cur.execute("SELECT * FROM post_metas ORDER BY id")
            rows = cur.fetchall()

        # Populate mappings for already-existing Post rows.
        if self.table_exists("Post"):
            with self.pg.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute('SELECT id, "legacyId" FROM "Post" WHERE "legacyId" IS NOT NULL')
                for r in cur.fetchall():
                    self.post_map.setdefault(int(r["legacyId"]), r["id"])

        for old in rows:
            legacy_post_id = int(old.get("post_id") or 0)
            new_post_id = self.post_map.get(legacy_post_id)
            if not new_post_id:
                continue
            existing = self.find_one("PostMeta", {"legacyId": int(old["id"])})
            values = {
                "legacyId": int(old["id"]),
                "postId": new_post_id,
                "key": old.get("key") or "",
                "value": old.get("value"),
                "createdAt": old.get("created_at") or datetime.utcnow(),
                "updatedAt": old.get("updated_at") or old.get("created_at") or datetime.utcnow(),
            }
            context = {"legacyId": int(old["id"]), "legacyPostId": legacy_post_id}
            if existing and not existing.get("__multiple__"):
                if old_is_newer(old.get("updated_at"), existing.get("updatedAt")):
                    self.update("PostMeta", existing["id"], values, context=context)
                else:
                    self.event("KEEP_NEW", "PostMeta", reason="new_not_older", **context)
            else:
                self.insert("PostMeta", values, context=context)

    def report_attachment_delta(self):
        print("7/8 Inspecting Attachment legacy coverage (report only)...")
        if not self.table_exists("Attachment") or "legacyId" not in self.columns("Attachment"):
            return
        with self.mysql.cursor() as cur:
            cur.execute("SELECT id, attachmentable_type, attachmentable_id FROM attachments ORDER BY id")
            old_rows = cur.fetchall()
        with self.pg.cursor() as cur:
            cur.execute('SELECT "legacyId" FROM "Attachment" WHERE "legacyId" IS NOT NULL')
            mapped = {int(r[0]) for r in cur.fetchall() if r[0] is not None}
        missing = [r for r in old_rows if int(r["id"]) not in mapped]
        if missing:
            self.event("ATTACHMENTS_REQUIRE_SEPARATE_MAPPING", "Attachment", count=len(missing))
            for r in missing[:50]:
                self.event(
                    "ATTACHMENT_UNMAPPED", "Attachment",
                    legacyId=int(r["id"]),
                    attachmentableType=r.get("attachmentable_type"),
                    attachmentableLegacyId=r.get("attachmentable_id"),
                )
        else:
            self.event("ATTACHMENTS_FULLY_MAPPED", "Attachment", count=len(old_rows))

    def consistency_checks(self):
        print("8/8 Running consistency checks...")
        # Orphan profiles in the simulated/applied map.
        missing_parents = 0
        with self.mysql.cursor() as cur:
            for table in ("settings", "services", "portfolios", "posts"):
                cur.execute(f"SELECT DISTINCT profile_id FROM {mysql_ident(table)} WHERE profile_id IS NOT NULL")
                for r in cur.fetchall():
                    pid = int(r["profile_id"])
                    if self.wanted_profile(pid) and pid not in self.profile_map:
                        missing_parents += 1
                        self.event("UNRESOLVED_PROFILE_PARENT", table, profileLegacyId=pid)
        if not missing_parents:
            self.event("CONSISTENCY_OK", "Profile", check="all_selected_legacy_parents_resolved")

    def write_report(self):
        report_path = Path(self.args.report or (
            f"/var/www/vbiz-me-backend/card-sync-report-"
            f"{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.json"
        ))
        report = {
            "mode": "APPLY" if self.apply else "DRY_RUN",
            "generatedAt": datetime.utcnow().isoformat() + "Z",
            "selectedProfiles": sorted(self.args.profile) if self.args.profile else "ALL",
            "excludedProfiles": sorted(self.args.exclude_profile),
            "summary": dict(sorted(self.summary.items())),
            "events": self.events,
        }
        report_path.write_text(json.dumps(report, indent=2, default=str))
        print("\n================ SUMMARY ================")
        for action, count in sorted(self.summary.items()):
            print(f"{action:36} {count}")
        print("=========================================")
        print(f"Report: {report_path}")
        if not self.apply:
            print("DRY RUN ONLY — PostgreSQL was not changed.")
        else:
            print("APPLY completed. No deletes were propagated.")

    def run(self):
        self.load_post_types()
        try:
            self.sync_profiles()
            self.sync_settings()
            self.sync_services()
            self.sync_portfolios()
            self.sync_posts()
            self.sync_post_metas()
            self.report_attachment_delta()
            self.consistency_checks()

            if self.apply:
                self.pg.commit()
            else:
                self.pg.rollback()

            self.write_report()
        except Exception:
            self.pg.rollback()
            raise
        finally:
            try:
                self.mysql.close()
            except Exception:
                pass
            try:
                self.pg.close()
            except Exception:
                pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Safely merge OLD MySQL vBiz Me card data into the existing NEW PostgreSQL schema."
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Read/compare only (default).")
    mode.add_argument("--apply", action="store_true", help="Apply safe inserts/updates.")
    p.add_argument(
        "--backups-confirmed", action="store_true",
        help="Required with --apply. Confirms you created fresh MySQL and PostgreSQL backups."
    )
    p.add_argument(
        "--profile", type=int, action="append", default=[],
        help="Only sync this OLD profile legacy ID. Repeat for multiple profiles."
    )
    p.add_argument(
        "--exclude-profile", type=int, action="append", default=[],
        help="Exclude this OLD profile legacy ID. Repeat for multiple profiles."
    )
    p.add_argument(
        "--allow-ownerless", action="store_true",
        help="Allow insertion of a missing Profile even when its OLD owner User cannot be resolved in NEW."
    )
    p.add_argument("--report", help="JSON report path.")
    args = p.parse_args()

    if args.apply and not args.backups_confirmed:
        die("--apply requires --backups-confirmed")
    return args


if __name__ == "__main__":
    args = parse_args()
    Sync(args).run()
