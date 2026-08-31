#!/usr/bin/env python3

import os
import uuid
import json
import argparse
import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor, Json

parser = argparse.ArgumentParser()
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()

def new_id():
    return "c" + uuid.uuid4().hex[:24]

my = pymysql.connect(
    host=os.environ["OLD_MYSQL_HOST"],
    port=int(os.environ.get("OLD_MYSQL_PORT", "3306")),
    user=os.environ["OLD_MYSQL_USER"],
    password=os.environ["OLD_MYSQL_PASSWORD"],
    database=os.environ["OLD_MYSQL_DATABASE"],
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
)

pg = psycopg2.connect(os.environ["NEW_DATABASE_URL"])

try:

    # ------------------------------------------------
    # PROFILE MAP
    # ------------------------------------------------

    with pg.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT id, "legacyId"
            FROM "Profile"
            WHERE "legacyId" IS NOT NULL
        """)

        profile_map = {
            int(r["legacyId"]): r["id"]
            for r in cur.fetchall()
        }

    # ------------------------------------------------
    # OLD SAVE CONTACTS
    # ------------------------------------------------

    with my.cursor() as cur:
        cur.execute("""
            SELECT *
            FROM event_logs
            WHERE LOWER(TRIM(event))='save_contact'
            ORDER BY id
        """)

        old_saves = cur.fetchall()

    old_save_ids = {int(r["id"]) for r in old_saves}

    # IMPORTANT:
    # Check existing legacy mapping BEFORE profile resolution.
    with pg.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT "legacyId", "eventType"
            FROM "EventLog"
            WHERE "legacyId" = ANY(%s)
        """, (list(old_save_ids),))

        mapped_rows = cur.fetchall()

    mapped_ids = {
        int(r["legacyId"])
        for r in mapped_rows
    }

    wrong = [
        r for r in mapped_rows
        if r["eventType"] != "save_contact_download"
    ]

    if wrong:
        print("STOP — WRONG EXISTING EVENT TYPES")
        for r in wrong:
            print(r)
        raise SystemExit(1)

    missing_saves = [
        r for r in old_saves
        if int(r["id"]) not in mapped_ids
    ]

    print("OLD save_contact total:", len(old_saves))
    print("Already mapped:", len(mapped_ids))
    print("Missing Save Contacts:", len(missing_saves))

    unresolved = []

    for r in missing_saves:
        pid = r.get("profile_id")

        if pid is None or int(pid) not in profile_map:
            unresolved.append(r)
            continue

    if unresolved:
        print("STOP — GENUINELY UNRESOLVED MISSING SAVE CONTACTS")
        for r in unresolved:
            print(r)
        raise SystemExit(1)

    # ------------------------------------------------
    # OLD GUEST/SAVED-CONTACT DATA
    # ------------------------------------------------

    with my.cursor() as cur:
        cur.execute("""
            SELECT *
            FROM guest_user_data
            ORDER BY id
        """)

        old_guests = cur.fetchall()

    with pg.cursor() as cur:
        cur.execute("""
            SELECT "legacyId"
            FROM "GuestUserData"
            WHERE "legacyId" IS NOT NULL
        """)

        mapped_guest_ids = {
            int(r[0])
            for r in cur.fetchall()
        }

    missing_guests = [
        r for r in old_guests
        if int(r["id"]) not in mapped_guest_ids
    ]

    print("OLD GuestUserData:", len(old_guests))
    print("Already mapped guests:", len(mapped_guest_ids))
    print("Missing guests:", len(missing_guests))

    guest_unresolved = [
        r for r in missing_guests
        if (
            r.get("profile_id") is None
            or int(r["profile_id"]) not in profile_map
        )
    ]

    if guest_unresolved:
        print("STOP — UNRESOLVED GUEST PROFILES")
        for r in guest_unresolved:
            print(r)
        raise SystemExit(1)

    if not args.apply:
        print()
        print("DRY RUN PASSED")
        print("Would insert Save Contacts:", len(missing_saves))
        print("Would insert Guest records:", len(missing_guests))
        print("NOTHING CHANGED")
        pg.rollback()
        raise SystemExit(0)

    # ------------------------------------------------
    # INSERT MISSING SAVE CONTACTS
    # ------------------------------------------------

    inserted_saves = 0

    for r in missing_saves:

        new_profile_id = profile_map[int(r["profile_id"])]

        created = (
            r.get("timestamp")
            or r.get("created_at")
        )

        payload = {
            "legacyEvent": "save_contact",
            "legacyUserId": r.get("user_id"),
            "legacyName": r.get("name"),
            "legacyDevice": r.get("device"),
            "legacyBrowser": r.get("browser"),
            "legacyPlatform": r.get("platform"),
            "legacyDeviceType": r.get("device_type"),
            "migratedFrom": "old_mysql.event_logs",
        }

        with pg.cursor() as cur:
            cur.execute("""
                INSERT INTO "EventLog" (
                    id,
                    "legacyId",
                    "profileId",
                    "eventType",
                    payload,
                    ip,
                    "userAgent",
                    "createdAt"
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                new_id(),
                int(r["id"]),
                new_profile_id,
                "save_contact_download",
                Json(payload),
                r.get("ip_address"),
                None,
                created,
            ))

        inserted_saves += 1

    # ------------------------------------------------
    # INSERT MISSING GUESTS
    # ------------------------------------------------

    inserted_guests = 0

    for r in missing_guests:

        new_profile_id = profile_map[int(r["profile_id"])]

        with pg.cursor() as cur:
            cur.execute("""
                INSERT INTO "GuestUserData" (
                    id,
                    "legacyId",
                    "profileId",
                    "firstName",
                    "lastName",
                    email,
                    "createdAt",
                    "updatedAt"
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                new_id(),
                int(r["id"]),
                new_profile_id,
                r.get("first_name"),
                r.get("last_name"),
                r.get("email"),
                r.get("created_at"),
                r.get("updated_at") or r.get("created_at"),
            ))

        inserted_guests += 1

    pg.commit()

    print()
    print("========================================")
    print("SAVE CONTACT MIGRATION COMMITTED")
    print("========================================")
    print("Inserted Save Contacts:", inserted_saves)
    print("Inserted Guest records:", inserted_guests)

finally:
    my.close()
    pg.close()
