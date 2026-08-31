#!/usr/bin/env python3

import os
import uuid
import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor


MYSQL_HOST = "13.53.83.153"
MYSQL_PORT = 3306
MYSQL_DB = "vbizme_app"
MYSQL_USER = "dbadmin"
MYSQL_PASSWORD = os.environ["VBIZME_MYSQL_PASSWORD"]

PG_DSN = os.environ["DATABASE_URL"].split("?")[0]


def new_id():
    return uuid.uuid4().hex


mysql = pymysql.connect(
    host=MYSQL_HOST,
    port=MYSQL_PORT,
    user=MYSQL_USER,
    password=MYSQL_PASSWORD,
    database=MYSQL_DB,
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    ssl_disabled=True,
)

pg = psycopg2.connect(PG_DSN)
pg.autocommit = False

mcur = mysql.cursor()
pcur = pg.cursor(cursor_factory=RealDictCursor)

try:

    # =====================================================
    # 1. LOAD ALL OLD SERVICE RECORDS
    # =====================================================

    mcur.execute("""
        SELECT
            id,
            title,
            description,
            status,
            profile_id,
            post_type_id,
            created_at,
            updated_at
        FROM services
        WHERE post_type_id IN (1,2,3)
        ORDER BY post_type_id, id
    """)

    source_rows = mcur.fetchall()

    type1_ids = {
        row["id"]
        for row in source_rows
        if row["post_type_id"] == 1
    }

    type2_ids = {
        row["id"]
        for row in source_rows
        if row["post_type_id"] == 2
    }

    type3_ids = {
        row["id"]
        for row in source_rows
        if row["post_type_id"] == 3
    }

    print("OLD MYSQL:")
    print("Services:", len(type1_ids))
    print("Clients :", len(type2_ids))
    print("Reviews :", len(type3_ids))

    # Expected:
    # Services = 295
    # Clients  = 181
    # Reviews  = 535


    # =====================================================
    # 2. MAKE SURE CLIENT/REVIEW MIGRATION IS COMPLETE
    # =====================================================

    pcur.execute('SELECT COUNT(*) AS total FROM "Client"')
    client_count = pcur.fetchone()["total"]

    pcur.execute('SELECT COUNT(*) AS total FROM "Review"')
    review_count = pcur.fetchone()["total"]

    print()
    print("CURRENT POSTGRES:")
    print("Client:", client_count)
    print("Review:", review_count)

    if client_count < len(type2_ids):
        raise RuntimeError(
            "Client migration is incomplete. "
            "Will NOT modify Service."
        )

    if review_count < len(type3_ids):
        raise RuntimeError(
            "Review migration is incomplete. "
            "Will NOT modify Service."
        )


    # =====================================================
    # 3. ENSURE ALL TYPE-1 RECORDS EXIST IN SERVICE
    # =====================================================

    inserted_services = 0
    missing_profile_maps = []

    for row in source_rows:

        if row["post_type_id"] != 1:
            continue

        # Is this legacy service already present?
        pcur.execute("""
            SELECT id
            FROM "Service"
            WHERE "legacyId" = %s
            LIMIT 1
        """, (row["id"],))

        existing = pcur.fetchone()

        if existing:
            continue

        # Map old profile_id to new PostgreSQL Profile.id
        pcur.execute("""
            SELECT id
            FROM "Profile"
            WHERE "legacyId" = %s
            LIMIT 1
        """, (row["profile_id"],))

        profile = pcur.fetchone()

        if not profile:
            missing_profile_maps.append({
                "legacyServiceId": row["id"],
                "legacyProfileId": row["profile_id"],
            })
            continue

        pcur.execute("""
            INSERT INTO "Service" (
                id,
                "legacyId",
                "profileId",
                title,
                description,
                status,
                "sortOrder",
                "createdAt",
                "updatedAt"
            )
            VALUES (
                %s,%s,%s,%s,%s,%s,0,%s,%s
            )
        """, (
            new_id(),
            row["id"],
            profile["id"],
            row["title"],
            row["description"],
            row["status"] if row["status"] is not None else 1,
            row["created_at"],
            row["updated_at"],
        ))

        inserted_services += 1


    if missing_profile_maps:
        print("\nMissing profile mappings:")
        for item in missing_profile_maps:
            print(item)

        raise RuntimeError(
            "Missing profile mappings. "
            "Rolling back before Service cleanup."
        )


    # =====================================================
    # 4. FIND SERVICE ROWS THAT ACTUALLY BELONG TO
    #    CLIENTS OR REVIEWS
    # =====================================================

    pcur.execute("""
        SELECT
            id,
            "legacyId",
            "profileId",
            title
        FROM "Service"
        WHERE "legacyId" IS NOT NULL
    """)

    pg_services = pcur.fetchall()

    wrong_service_ids = []

    for service in pg_services:

        legacy_id = service["legacyId"]

        if legacy_id in type2_ids or legacy_id in type3_ids:
            wrong_service_ids.append(service)


    print()
    print(
        "Client/Review records incorrectly "
        "inside Service:",
        len(wrong_service_ids)
    )


    # =====================================================
    # 5. CHECK ATTACHMENTS BEFORE DELETING
    # =====================================================

    attachment_count = 0

    for service in wrong_service_ids:

        pcur.execute("""
            SELECT COUNT(*) AS total
            FROM "Attachment"
            WHERE "attachableId" = %s
              AND LOWER("attachableType") LIKE '%%service%%'
        """, (service["id"],))

        attachment_count += pcur.fetchone()["total"]


    print(
        "Attachments linked to misplaced "
        "Service records:",
        attachment_count
    )

    # IMPORTANT:
    # If there are attachments, DO NOT delete the Service
    # records automatically yet.
    #
    # They must be re-associated with Client/Review first.

    if attachment_count > 0:

        print()
        print("============================================")
        print("STOPPED SAFELY")
        print("============================================")
        print(
            "Some Client/Review records still have "
            "attachments linked through Service."
        )
        print(
            "No Service records were deleted."
        )
        print(
            "We must migrate those attachment relationships "
            "to Client/Review before deleting."
        )

        pg.rollback()
        raise SystemExit(2)


    # =====================================================
    # 6. DELETE ONLY CLIENT/REVIEW ROWS FROM SERVICE
    # =====================================================

    deleted = 0

    for service in wrong_service_ids:

        pcur.execute("""
            DELETE FROM "Service"
            WHERE id = %s
        """, (service["id"],))

        deleted += pcur.rowcount


    # =====================================================
    # 7. VERIFY FINAL COUNTS
    # =====================================================

    pcur.execute('SELECT COUNT(*) AS total FROM "Service"')
    final_service_count = pcur.fetchone()["total"]

    pcur.execute('SELECT COUNT(*) AS total FROM "Client"')
    final_client_count = pcur.fetchone()["total"]

    pcur.execute('SELECT COUNT(*) AS total FROM "Review"')
    final_review_count = pcur.fetchone()["total"]


    print()
    print("============================================")
    print("SERVICES AREA CLEANUP")
    print("============================================")

    print("Expected Services:", len(type1_ids))
    print("Expected Clients :", len(type2_ids))
    print("Expected Reviews :", len(type3_ids))

    print()

    print("Service final:", final_service_count)
    print("Client final :", final_client_count)
    print("Review final :", final_review_count)

    print()

    print("Type-1 Service rows inserted:", inserted_services)
    print("Wrong Service rows deleted   :", deleted)

    print("============================================")


    # Exact validation
    if final_service_count != len(type1_ids):
        raise RuntimeError(
            f"Service count mismatch. "
            f"Expected {len(type1_ids)}, "
            f"got {final_service_count}."
        )

    if final_client_count < len(type2_ids):
        raise RuntimeError("Client count mismatch.")

    if final_review_count < len(type3_ids):
        raise RuntimeError("Review count mismatch.")


    pg.commit()

    print()
    print("COMMIT SUCCESSFUL.")
    print()
    print("Final architecture:")
    print("Service → type 1 only")
    print("Client  → type 2 only")
    print("Review  → type 3 only")
    print()
    print("Old MariaDB data was NOT modified.")


except SystemExit:
    raise

except Exception:
    pg.rollback()
    raise

finally:
    mcur.close()
    mysql.close()

    pcur.close()
    pg.close()
