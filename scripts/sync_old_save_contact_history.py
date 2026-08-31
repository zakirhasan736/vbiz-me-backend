#!/usr/bin/env python3

import os
import sys
import json
import uuid
import argparse
from collections import Counter

import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor, Json


def new_id():
    return "c" + uuid.uuid4().hex[:24]


parser = argparse.ArgumentParser()
parser.add_argument(
    "--apply",
    action="store_true",
)
parser.add_argument(
    "--backups-confirmed",
    action="store_true",
)

args = parser.parse_args()

if args.apply and not args.backups_confirmed:
    raise SystemExit(
        "STOP: --apply requires --backups-confirmed"
    )


my = pymysql.connect(
    host=os.environ["OLD_MYSQL_HOST"],
    port=int(
        os.environ.get(
            "OLD_MYSQL_PORT",
            "3306",
        )
    ),
    user=os.environ["OLD_MYSQL_USER"],
    password=os.environ["OLD_MYSQL_PASSWORD"],
    database=os.environ["OLD_MYSQL_DATABASE"],
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
)

pg = psycopg2.connect(
    os.environ["NEW_DATABASE_URL"]
)

events = []
counts = Counter()


def event(action, **kw):
    counts[action] += 1
    row = {
        "action": action,
        **kw,
    }
    events.append(row)


try:

    # ========================================================
    # PROFILE MAP
    # ========================================================

    with pg.cursor(
        cursor_factory=RealDictCursor
    ) as cur:

        cur.execute("""
            SELECT id, "legacyId"
            FROM "Profile"
            WHERE "legacyId" IS NOT NULL
        """)

        profile_map = {
            int(r["legacyId"]): r["id"]
            for r in cur.fetchall()
        }


    # ========================================================
    # LOAD ALL OLD SAVE-CONTACT EVENTS
    # ========================================================

    with my.cursor() as cur:

        cur.execute("""
            SELECT
                id,
                event,
                profile_id,
                user_id,
                timestamp,
                created_at,
                updated_at,
                name,
                ip_address,
                device,
                browser,
                platform,
                device_type
            FROM event_logs
            WHERE LOWER(TRIM(event))
                  = 'save_contact'
            ORDER BY id
        """)

        old_saves = cur.fetchall()


    print(
        "OLD save_contact events:",
        len(old_saves),
    )


    # ========================================================
    # VERIFY EXISTING MIGRATION MAPPING
    # ========================================================

    old_save_ids = [
        int(r["id"])
        for r in old_saves
    ]

    mapped_type_counts = Counter()

    with pg.cursor(
        cursor_factory=RealDictCursor
    ) as cur:

        cur.execute("""
            SELECT
                "legacyId",
                "eventType"
            FROM "EventLog"
            WHERE "legacyId" = ANY(%s)
        """, (old_save_ids,))

        existing_old_saves = cur.fetchall()


    for r in existing_old_saves:
        mapped_type_counts[
            r["eventType"]
        ] += 1


    print(
        "Existing OLD save mappings:",
        dict(mapped_type_counts),
    )


    wrong_types = [
        r
        for r in existing_old_saves
        if r["eventType"]
           != "save_contact_download"
    ]


    if wrong_types:
        print()
        print(
            "STOP: existing OLD save_contact "
            "records use unexpected NEW event types."
        )

        for r in wrong_types[:25]:
            print(r)

        raise RuntimeError(
            "Unexpected save-contact mapping"
        )


    # ========================================================
    # MIGRATE / LINK SAVE CONTACT HISTORY
    # ========================================================

    for old in old_saves:

        legacy_id = int(old["id"])
        old_profile_id = old["profile_id"]

        if old_profile_id is None:
            event(
                "UNRESOLVED_PROFILE",
                legacyId=legacy_id,
                profileLegacyId=None,
            )
            continue

        new_profile_id = profile_map.get(
            int(old_profile_id)
        )

        if not new_profile_id:
            event(
                "UNRESOLVED_PROFILE",
                legacyId=legacy_id,
                profileLegacyId=int(
                    old_profile_id
                ),
            )
            continue


        with pg.cursor(
            cursor_factory=RealDictCursor
        ) as cur:

            cur.execute("""
                SELECT
                    id,
                    "eventType"
                FROM "EventLog"
                WHERE "legacyId"=%s
            """, (legacy_id,))

            existing = cur.fetchone()


        if existing:

            if (
                existing["eventType"]
                != "save_contact_download"
            ):
                raise RuntimeError(
                    f"Legacy EventLog {legacy_id} "
                    "has wrong eventType "
                    f"{existing['eventType']}"
                )

            event(
                "KEEP_EXISTING",
                legacyId=legacy_id,
            )
            continue


        occurred_at = (
            old.get("timestamp")
            or old.get("created_at")
        )

        if occurred_at is None:
            event(
                "UNRESOLVED_TIMESTAMP",
                legacyId=legacy_id,
            )
            continue


        # ----------------------------------------------------
        # DUPLICATE GUARD
        #
        # OLD timestamps are second-resolution.
        # Check same profile/event/second among NEW-only rows.
        # ----------------------------------------------------

        with pg.cursor(
            cursor_factory=RealDictCursor
        ) as cur:

            cur.execute("""
                SELECT
                    id,
                    "legacyId",
                    "createdAt"
                FROM "EventLog"
                WHERE "legacyId" IS NULL
                  AND "profileId"=%s
                  AND "eventType"=
                      'save_contact_download'
                  AND DATE_TRUNC(
                        'second',
                        "createdAt"
                      ) =
                      DATE_TRUNC(
                        'second',
                        %s::timestamp
                      )
                ORDER BY "createdAt"
            """, (
                new_profile_id,
                occurred_at,
            ))

            semantic_matches = (
                cur.fetchall()
            )


        if len(semantic_matches) > 1:
            event(
                "AMBIGUOUS_NEW_MATCH",
                legacyId=legacy_id,
                profileLegacyId=int(
                    old_profile_id
                ),
                matches=[
                    r["id"]
                    for r in semantic_matches
                ],
            )
            continue


        if len(semantic_matches) == 1:

            row_id = semantic_matches[0]["id"]

            if args.apply:

                with pg.cursor() as cur:
                    cur.execute("""
                        UPDATE "EventLog"
                        SET "legacyId"=%s
                        WHERE id=%s
                          AND "legacyId" IS NULL
                    """, (
                        legacy_id,
                        row_id,
                    ))

                    if cur.rowcount != 1:
                        raise RuntimeError(
                            "Event legacyId link "
                            f"failed: {legacy_id}"
                        )

                event(
                    "LINK_EXISTING_NEW_EVENT",
                    legacyId=legacy_id,
                    rowId=row_id,
                )

            else:

                event(
                    "WOULD_LINK_EXISTING_NEW_EVENT",
                    legacyId=legacy_id,
                    rowId=row_id,
                )

            continue


        payload = {
            "legacyEvent": old.get(
                "event"
            ),
            "legacyUserId": old.get(
                "user_id"
            ),
            "legacyName": old.get(
                "name"
            ),
            "legacyDevice": old.get(
                "device"
            ),
            "legacyBrowser": old.get(
                "browser"
            ),
            "legacyPlatform": old.get(
                "platform"
            ),
            "legacyDeviceType": old.get(
                "device_type"
            ),
            "migratedFrom":
                "old_mysql.event_logs",
        }


        if args.apply:

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
                    VALUES (
                        %s,%s,%s,%s,%s,%s,%s,%s
                    )
                """, (
                    new_id(),
                    legacy_id,
                    new_profile_id,
                    "save_contact_download",
                    Json(payload),
                    old.get("ip_address"),
                    None,
                    occurred_at,
                ))

            event(
                "INSERT_SAVE_CONTACT",
                legacyId=legacy_id,
                profileLegacyId=int(
                    old_profile_id
                ),
            )

        else:

            event(
                "WOULD_INSERT_SAVE_CONTACT",
                legacyId=legacy_id,
                profileLegacyId=int(
                    old_profile_id
                ),
            )


    # ========================================================
    # GUEST USER DATA
    # ========================================================

    with my.cursor() as cur:

        cur.execute("""
            SELECT
                id,
                first_name,
                last_name,
                email,
                profile_id,
                created_at,
                updated_at
            FROM guest_user_data
            ORDER BY id
        """)

        old_guests = cur.fetchall()


    for old in old_guests:

        legacy_id = int(old["id"])

        with pg.cursor(
            cursor_factory=RealDictCursor
        ) as cur:

            cur.execute("""
                SELECT id
                FROM "GuestUserData"
                WHERE "legacyId"=%s
            """, (legacy_id,))

            existing = cur.fetchone()


        if existing:

            event(
                "KEEP_GUEST",
                legacyId=legacy_id,
            )
            continue


        old_profile_id = old.get(
            "profile_id"
        )

        new_profile_id = (
            profile_map.get(
                int(old_profile_id)
            )
            if old_profile_id is not None
            else None
        )


        if not new_profile_id:
            event(
                "UNRESOLVED_GUEST_PROFILE",
                legacyId=legacy_id,
                profileLegacyId=old_profile_id,
            )
            continue


        # Semantic duplicate guard:
        # same card + same email.
        with pg.cursor(
            cursor_factory=RealDictCursor
        ) as cur:

            cur.execute("""
                SELECT
                    id,
                    "legacyId",
                    "firstName",
                    "lastName",
                    email
                FROM "GuestUserData"
                WHERE "profileId"=%s
                  AND LOWER(
                        COALESCE(email,'')
                      ) =
                      LOWER(
                        COALESCE(%s,'')
                      )
                ORDER BY "createdAt"
            """, (
                new_profile_id,
                old.get("email"),
            ))

            matches = cur.fetchall()


        null_legacy_matches = [
            r for r in matches
            if r["legacyId"] is None
        ]


        if len(null_legacy_matches) == 1:

            row_id = (
                null_legacy_matches[0]["id"]
            )

            if args.apply:

                with pg.cursor() as cur:

                    cur.execute("""
                        UPDATE "GuestUserData"
                        SET "legacyId"=%s
                        WHERE id=%s
                          AND "legacyId" IS NULL
                    """, (
                        legacy_id,
                        row_id,
                    ))

                    if cur.rowcount != 1:
                        raise RuntimeError(
                            "Guest legacyId link "
                            f"failed: {legacy_id}"
                        )

                event(
                    "LINK_EXISTING_GUEST",
                    legacyId=legacy_id,
                    rowId=row_id,
                )

            else:

                event(
                    "WOULD_LINK_EXISTING_GUEST",
                    legacyId=legacy_id,
                    rowId=row_id,
                )

            continue


        if len(null_legacy_matches) > 1:

            event(
                "AMBIGUOUS_GUEST_MATCH",
                legacyId=legacy_id,
                matches=[
                    r["id"]
                    for r
                    in null_legacy_matches
                ],
            )

            continue


        if args.apply:

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
                    VALUES (
                        %s,%s,%s,%s,%s,%s,%s,%s
                    )
                """, (
                    new_id(),
                    legacy_id,
                    new_profile_id,
                    old.get("first_name"),
                    old.get("last_name"),
                    old.get("email"),
                    old.get("created_at"),
                    old.get("updated_at")
                    or old.get("created_at"),
                ))

            event(
                "INSERT_GUEST",
                legacyId=legacy_id,
            )

        else:

            event(
                "WOULD_INSERT_GUEST",
                legacyId=legacy_id,
            )


    # ========================================================
    # HARD SAFETY GATE
    # ========================================================

    blockers = (
        counts["UNRESOLVED_PROFILE"]
        + counts["UNRESOLVED_TIMESTAMP"]
        + counts["AMBIGUOUS_NEW_MATCH"]
        + counts["UNRESOLVED_GUEST_PROFILE"]
        + counts["AMBIGUOUS_GUEST_MATCH"]
    )


    print()
    print("======================================")
    print("SUMMARY")
    print("======================================")

    for k, v in sorted(counts.items()):
        print(f"{k:35} {v}")


    if blockers:

        print()
        print(
            "STOP — unresolved/ambiguous "
            "records exist."
        )

        pg.rollback()

        report = (
            "save-contact-sync-blockers.json"
        )

        with open(report, "w") as f:
            json.dump(
                events,
                f,
                indent=2,
                default=str,
            )

        print("Report:", report)

        raise SystemExit(1)


    if args.apply:
        pg.commit()

        print()
        print(
            "APPLY COMMITTED SUCCESSFULLY"
        )

    else:
        pg.rollback()

        print()
        print(
            "DRY RUN ONLY — NOTHING CHANGED"
        )


finally:
    my.close()
    pg.close()
