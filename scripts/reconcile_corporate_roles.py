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
    with my.cursor() as c:
        c.execute("""
            SELECT id,name
            FROM roles
            WHERE name IN ('Corporate Admin','Corporate User')
            ORDER BY id
        """)
        roles = c.fetchall()

    role_ids = {
        r["name"]: int(r["id"])
        for r in roles
    }

    if set(role_ids) != {"Corporate Admin","Corporate User"}:
        raise RuntimeError(f"Unexpected OLD role configuration: {role_ids}")

    with my.cursor() as c:
        c.execute("""
            SELECT role_id,model_id
            FROM model_has_roles
            WHERE role_id IN (%s,%s)
            ORDER BY model_id
        """, (
            role_ids["Corporate Admin"],
            role_ids["Corporate User"],
        ))
        rows = c.fetchall()

    corporate_admins = {
        int(r["model_id"])
        for r in rows
        if int(r["role_id"]) == role_ids["Corporate Admin"]
    }

    corporate_users = {
        int(r["model_id"])
        for r in rows
        if int(r["role_id"]) == role_ids["Corporate User"]
    }

    if corporate_admins & corporate_users:
        raise RuntimeError("OLD role sets overlap")

    print("OLD Corporate Admins:", len(corporate_admins))
    print("OLD Corporate Users:", len(corporate_users))

    if len(corporate_admins) != 16 or len(corporate_users) != 22:
        raise RuntimeError("Expected OLD distribution 16 Corporate Admin / 22 Corporate User")

    # Confirm Corporate subscriptions belong to OLD Corporate Admins.
    with my.cursor() as c:
        c.execute("""
            SELECT DISTINCT user_id
            FROM subscriptions
            WHERE LOWER(TRIM(COALESCE(name,'')))='corporate'
               OR LOWER(TRIM(COALESCE(provider,'')))='corporate'
        """)
        subscription_owners = {
            int(r["user_id"])
            for r in c.fetchall()
            if r["user_id"] is not None
        }

    print("OLD corporate subscription owners:", len(subscription_owners))

    if subscription_owners != corporate_admins:
        print("Corporate Admin IDs:", sorted(corporate_admins))
        print("Subscription owner IDs:", sorted(subscription_owners))
        raise RuntimeError(
            "STOP: corporate subscription owners do not exactly match "
            "Corporate Admin role set"
        )

    expected = {}

    for legacy_id in corporate_admins:
        expected[legacy_id] = "corporate-owner"

    for legacy_id in corporate_users:
        expected[legacy_id] = "vcard-owner"

    legacy_ids = sorted(expected)

    with pg.cursor(cursor_factory=RealDictCursor) as c:
        c.execute("""
            SELECT id,"legacyId",name,email,role
            FROM "User"
            WHERE "legacyId" = ANY(%s)
            ORDER BY "legacyId"
        """, (legacy_ids,))
        new_rows = c.fetchall()

    if len(new_rows) != 38:
        raise RuntimeError(
            f"Expected 38 NEW corporate-role users; found {len(new_rows)}"
        )

    current = Counter(str(r["role"]) for r in new_rows)
    print("CURRENT NEW:", dict(current))

    changes=[]

    for r in new_rows:
        legacy_id=int(r["legacyId"])
        target=expected[legacy_id]

        if r["role"] != target:
            changes.append({
                "id": r["id"],
                "legacyId": legacy_id,
                "name": r["name"],
                "from": r["role"],
                "to": target,
            })

    print("CHANGES REQUIRED:", len(changes))

    for r in changes:
        print(r)

    if not args.apply:
        print()
        print("DRY RUN PASSED — NOTHING CHANGED")
        pg.rollback()
        raise SystemExit(0)

    with pg.cursor() as c:
        for r in changes:
            c.execute("""
                UPDATE "User"
                SET role=%s,
                    "updatedAt"=NOW()
                WHERE id=%s
                  AND role=%s
            """, (
                r["to"],
                r["id"],
                r["from"],
            ))

            if c.rowcount != 1:
                raise RuntimeError(
                    f"Role update failed for OLD User {r['legacyId']}"
                )

    pg.commit()

    with pg.cursor(cursor_factory=RealDictCursor) as c:
        c.execute("""
            SELECT role,COUNT(*) AS total
            FROM "User"
            WHERE "legacyId" = ANY(%s)
            GROUP BY role
            ORDER BY role
        """, (legacy_ids,))
        final_rows=c.fetchall()

    print()
    print("FINAL NEW ROLE DISTRIBUTION")
    for r in final_rows:
        print(dict(r))

    print("COMMITTED SUCCESSFULLY")

finally:
    my.close()
    pg.close()
