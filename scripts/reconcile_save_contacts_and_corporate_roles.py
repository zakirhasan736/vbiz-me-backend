#!/usr/bin/env python3

import os
import argparse
import pymysql
import psycopg2
from collections import Counter
from psycopg2.extras import RealDictCursor

parser = argparse.ArgumentParser()
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()

my = pymysql.connect(
    host=os.environ["OLD_MYSQL_HOST"],
    port=int(os.environ["OLD_MYSQL_PORT"]),
    user=os.environ["OLD_MYSQL_USER"],
    password=os.environ["OLD_MYSQL_PASSWORD"],
    database=os.environ["OLD_MYSQL_DATABASE"],
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    ssl_disabled=True,
)

pg = psycopg2.connect(os.environ["NEW_DATABASE_URL"])

try:
    print("\n========================================")
    print("1. SAVE CONTACT PROFILE REPAIR")
    print("========================================")

    with my.cursor() as c:
        c.execute("""
            SELECT
                id,
                profile_id
            FROM event_logs
            WHERE LOWER(TRIM(event))='save_contact'
            ORDER BY id
        """)
        old_saves = {
            int(r["id"]): r["profile_id"]
            for r in c.fetchall()
        }

    with pg.cursor(cursor_factory=RealDictCursor) as c:
        c.execute("""
            SELECT
                id,
                "legacyId",
                "profileId"
            FROM "EventLog"
            WHERE "eventType"='save_contact_download'
              AND "legacyId" IS NOT NULL
              AND "profileId" IS NULL
            ORDER BY "legacyId"
        """)
        orphan_saves = c.fetchall()

    print("Mapped OLD Save Contacts with NULL profile:", len(orphan_saves))

    save_repairs = []

    for row in orphan_saves:
        legacy_event = int(row["legacyId"])
        old_profile = old_saves.get(legacy_event)

        if old_profile is None:
            raise RuntimeError(
                f"OLD save event {legacy_event} has no profile_id"
            )

        with pg.cursor(cursor_factory=RealDictCursor) as c:
            c.execute("""
                SELECT
                    id,
                    "legacyId",
                    name,
                    slug
                FROM "Profile"
                WHERE "legacyId"=%s
            """, (int(old_profile),))

            profiles = c.fetchall()

        if len(profiles) != 1:
            raise RuntimeError(
                f"Expected exactly one NEW Profile for OLD profile "
                f"{old_profile}; found {len(profiles)}"
            )

        profile = profiles[0]

        save_repairs.append({
            "eventRowId": row["id"],
            "eventLegacyId": legacy_event,
            "profileLegacyId": int(old_profile),
            "newProfileId": profile["id"],
            "name": profile["name"],
            "slug": profile["slug"],
        })

    for r in save_repairs:
        print(r)

    if len(save_repairs) != 10:
        raise RuntimeError(
            f"Expected exactly 10 Save Contact profile repairs; "
            f"found {len(save_repairs)}"
        )

    print("\n========================================")
    print("2. OLD CORPORATE ROLE SOURCE")
    print("========================================")

    with my.cursor() as c:
        c.execute("""
            SELECT id, name
            FROM roles
            WHERE name IN (
                'Corporate Admin',
                'Corporate User'
            )
            ORDER BY id
        """)
        roles = c.fetchall()

    role_ids = {
        r["name"]: int(r["id"])
        for r in roles
    }

    if set(role_ids) != {
        "Corporate Admin",
        "Corporate User",
    }:
        raise RuntimeError(
            f"Unexpected OLD corporate roles: {role_ids}"
        )

    with my.cursor() as c:
        c.execute("""
            SELECT
                role_id,
                model_id
            FROM model_has_roles
            WHERE role_id IN (%s,%s)
            ORDER BY model_id
        """, (
            role_ids["Corporate Admin"],
            role_ids["Corporate User"],
        ))

        role_rows = c.fetchall()

    corp_admins = {
        int(r["model_id"])
        for r in role_rows
        if int(r["role_id"])
            == role_ids["Corporate Admin"]
    }

    corp_users = {
        int(r["model_id"])
        for r in role_rows
        if int(r["role_id"])
            == role_ids["Corporate User"]
    }

    print("OLD Corporate Admins:", len(corp_admins))
    print("OLD Corporate Users:", len(corp_users))

    if len(corp_admins) != 16:
        raise RuntimeError(
            f"Expected 16 Corporate Admins; found {len(corp_admins)}"
        )

    if len(corp_users) != 22:
        raise RuntimeError(
            f"Expected 22 Corporate Users; found {len(corp_users)}"
        )

    if corp_admins & corp_users:
        raise RuntimeError(
            "Same OLD user is both Corporate Admin and Corporate User"
        )

    all_corporate_users = sorted(
        corp_admins | corp_users
    )

    with pg.cursor(cursor_factory=RealDictCursor) as c:
        c.execute("""
            SELECT
                id,
                "legacyId",
                name,
                email,
                role
            FROM "User"
            WHERE "legacyId" = ANY(%s)
            ORDER BY "legacyId"
        """, (all_corporate_users,))

        new_users = c.fetchall()

    by_legacy = {
        int(r["legacyId"]): r
        for r in new_users
    }

    missing = sorted(
        set(all_corporate_users)
        - set(by_legacy)
    )

    if missing:
        raise RuntimeError(
            f"Corporate users missing in NEW: {missing}"
        )

    current_roles = Counter(
        str(r["role"])
        for r in new_users
    )

    print("CURRENT NEW ROLE DISTRIBUTION:", dict(current_roles))

    allowed_targets = {
        "corporate-owner",
        "vcard-owner",
    }

    all_current_values = {
        str(r["role"])
        for r in new_users
    }

    if not all_current_values <= allowed_targets:
        raise RuntimeError(
            f"Unexpected NEW corporate role values: "
            f"{sorted(all_current_values)}"
        )

    role_changes = []

    for legacy_id in all_corporate_users:
        row = by_legacy[legacy_id]

        expected = (
            "corporate-owner"
            if legacy_id in corp_admins
            else "vcard-owner"
        )

        if row["role"] != expected:
            role_changes.append({
                "userId": row["id"],
                "legacyId": legacy_id,
                "name": row["name"],
                "from": row["role"],
                "to": expected,
            })

    print("\nROLE CHANGES REQUIRED:", len(role_changes))

    for r in role_changes:
        print(r)

    print("\n========================================")
    print("3. CORPORATE SUBSCRIPTION CHECK")
    print("========================================")

    with my.cursor() as c:
        c.execute("""
            SELECT DISTINCT user_id
            FROM subscriptions
            WHERE LOWER(TRIM(COALESCE(name,'')))='corporate'
               OR LOWER(TRIM(COALESCE(provider,'')))='corporate'
        """)

        old_subscription_owners = {
            int(r["user_id"])
            for r in c.fetchall()
            if r["user_id"] is not None
        }

    print("OLD corporate subscription owners:", len(old_subscription_owners))

    if old_subscription_owners != corp_admins:
        print(
            "WARNING: OLD corporate subscription owners "
            "do not exactly equal Corporate Admin role set."
        )
        print(
            "Only role mappings will be changed. "
            "Subscriptions will NOT be deleted or rewritten."
        )

    if not args.apply:
        print("\n========================================")
        print("DRY RUN PASSED")
        print("========================================")
        print("Save Contact repairs:", len(save_repairs))
        print("Corporate role changes:", len(role_changes))
        print("NOTHING CHANGED")
        pg.rollback()
        raise SystemExit(0)

    print("\n========================================")
    print("4. APPLY")
    print("========================================")

    with pg.cursor() as c:
        for r in save_repairs:
            c.execute("""
                UPDATE "EventLog"
                SET "profileId"=%s
                WHERE id=%s
                  AND "profileId" IS NULL
            """, (
                r["newProfileId"],
                r["eventRowId"],
            ))

            if c.rowcount != 1:
                raise RuntimeError(
                    f"Save repair failed for legacy event "
                    f"{r['eventLegacyId']}"
                )

        for r in role_changes:
            c.execute("""
                UPDATE "User"
                SET role=%s,
                    "updatedAt"=NOW()
                WHERE id=%s
                  AND role=%s
            """, (
                r["to"],
                r["userId"],
                r["from"],
            ))

            if c.rowcount != 1:
                raise RuntimeError(
                    f"Role repair failed for OLD user "
                    f"{r['legacyId']}"
                )

    pg.commit()

    print("COMMITTED")
    print("Save Contact profile repairs:", len(save_repairs))
    print("Corporate role changes:", len(role_changes))

finally:
    my.close()
    pg.close()
