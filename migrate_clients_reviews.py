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
    # -----------------------------------------------------
    # Create Client table
    # -----------------------------------------------------

    pcur.execute("""
        CREATE TABLE IF NOT EXISTS "Client" (
            id TEXT PRIMARY KEY,
            "profileId" TEXT NOT NULL,
            "legacyServiceId" INTEGER UNIQUE,
            title TEXT,
            description TEXT,
            status INTEGER NOT NULL DEFAULT 1,
            "sortOrder" INTEGER NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT "Client_profileId_fkey"
                FOREIGN KEY ("profileId")
                REFERENCES "Profile"(id)
                ON UPDATE CASCADE
                ON DELETE CASCADE
        )
    """)

    pcur.execute("""
        CREATE INDEX IF NOT EXISTS "Client_profileId_idx"
        ON "Client"("profileId")
    """)

    # -----------------------------------------------------
    # Review table already exists
    # Add legacyServiceId if missing
    # -----------------------------------------------------

    pcur.execute("""
        ALTER TABLE "Review"
        ADD COLUMN IF NOT EXISTS "legacyServiceId" INTEGER
    """)

    pcur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS "Review_legacyServiceId_key"
        ON "Review"("legacyServiceId")
    """)

    # -----------------------------------------------------
    # Fetch Clients + Reviews from old MariaDB
    # -----------------------------------------------------

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
        WHERE post_type_id IN (2,3)
        ORDER BY post_type_id, id
    """)

    rows = mcur.fetchall()

    clients_created = 0
    reviews_created = 0
    skipped = 0
    missing_profiles = []

    for row in rows:
        # map old profile id to PostgreSQL profile id
        pcur.execute("""
            SELECT id
            FROM "Profile"
            WHERE "legacyId" = %s
            LIMIT 1
        """, (row["profile_id"],))

        profile = pcur.fetchone()

        if not profile:
            missing_profiles.append({
                "legacy_service_id": row["id"],
                "legacy_profile_id": row["profile_id"],
                "post_type_id": row["post_type_id"],
            })
            continue

        profile_id = profile["id"]

        # -------------------------------------------------
        # CLIENT
        # -------------------------------------------------

        if row["post_type_id"] == 2:
            pcur.execute("""
                SELECT id
                FROM "Client"
                WHERE "legacyServiceId" = %s
            """, (row["id"],))

            if pcur.fetchone():
                skipped += 1
                continue

            pcur.execute("""
                INSERT INTO "Client" (
                    id,
                    "profileId",
                    "legacyServiceId",
                    title,
                    description,
                    status,
                    "createdAt",
                    "updatedAt"
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                new_id(),
                profile_id,
                row["id"],
                row["title"],
                row["description"],
                row["status"] if row["status"] is not None else 1,
                row["created_at"],
                row["updated_at"],
            ))

            clients_created += 1

        # -------------------------------------------------
        # REVIEW
        # -------------------------------------------------

        elif row["post_type_id"] == 3:
            pcur.execute("""
                SELECT id
                FROM "Review"
                WHERE "legacyServiceId" = %s
            """, (row["id"],))

            if pcur.fetchone():
                skipped += 1
                continue

            pcur.execute("""
                INSERT INTO "Review" (
                    id,
                    "profileId",
                    "legacyServiceId",
                    author,
                    text,
                    rating,
                    status,
                    "sortOrder",
                    "createdAt",
                    "updatedAt"
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                new_id(),
                profile_id,
                row["id"],
                row["title"],
                row["description"],
                5,
                row["status"] if row["status"] is not None else 1,
                0,
                row["created_at"],
                row["updated_at"],
            ))

            reviews_created += 1

    # -----------------------------------------------------
    # Verification
    # -----------------------------------------------------

    pcur.execute('SELECT COUNT(*) AS total FROM "Client"')
    client_total = pcur.fetchone()["total"]

    pcur.execute('SELECT COUNT(*) AS total FROM "Review"')
    review_total = pcur.fetchone()["total"]

    print()
    print("==========================================")
    print("CLIENT / REVIEW MIGRATION")
    print("==========================================")
    print("Expected Clients source: 181")
    print("Expected Reviews source: 535")
    print()
    print("Clients created:         ", clients_created)
    print("Reviews created:         ", reviews_created)
    print("Already existing:        ", skipped)
    print()
    print("Client destination:      ", client_total)
    print("Review destination:      ", review_total)
    print("Missing profile maps:    ", len(missing_profiles))
    print("==========================================")

    if missing_profiles:
        print("\nMissing profile mappings:")
        for item in missing_profiles:
            print(item)

        raise RuntimeError(
            "Stopped because some MariaDB profile IDs "
            "could not map to PostgreSQL Profile.legacyId."
        )

    if client_total < 181:
        raise RuntimeError("Client destination count is below 181.")

    if review_total < 535:
        raise RuntimeError("Review destination count is below 535.")

    pg.commit()

    print("\nCOMMIT SUCCESSFUL.")
    print("Old MariaDB services data was NOT deleted.")

except Exception:
    pg.rollback()
    raise

finally:
    mcur.close()
    mysql.close()
    pcur.close()
    pg.close()
