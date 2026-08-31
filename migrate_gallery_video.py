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
    # ---------------------------------------------------------
    # Create destination tables
    # ---------------------------------------------------------

    pcur.execute("""
        CREATE TABLE IF NOT EXISTS "Gallery" (
            id TEXT PRIMARY KEY,
            "profileId" TEXT NOT NULL,
            "legacyPortfolioId" INTEGER UNIQUE,
            title TEXT,
            description TEXT,
            url TEXT,
            status INTEGER NOT NULL DEFAULT 1,
            "sortOrder" INTEGER NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "Gallery_profileId_fkey"
                FOREIGN KEY ("profileId")
                REFERENCES "Profile"(id)
                ON UPDATE CASCADE
                ON DELETE CASCADE
        )
    """)

    pcur.execute("""
        CREATE INDEX IF NOT EXISTS "Gallery_profileId_idx"
        ON "Gallery"("profileId")
    """)

    pcur.execute("""
        CREATE TABLE IF NOT EXISTS "Video" (
            id TEXT PRIMARY KEY,
            "profileId" TEXT NOT NULL,
            "legacyPortfolioId" INTEGER UNIQUE,
            title TEXT,
            description TEXT,
            url TEXT,
            status INTEGER NOT NULL DEFAULT 1,
            "sortOrder" INTEGER NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "Video_profileId_fkey"
                FOREIGN KEY ("profileId")
                REFERENCES "Profile"(id)
                ON UPDATE CASCADE
                ON DELETE CASCADE
        )
    """)

    pcur.execute("""
        CREATE INDEX IF NOT EXISTS "Video_profileId_idx"
        ON "Video"("profileId")
    """)

    # ---------------------------------------------------------
    # Load old Gallery + Video rows
    # ---------------------------------------------------------

    mcur.execute("""
        SELECT
            id,
            profile_id,
            title,
            description,
            status,
            url,
            created_at,
            updated_at,
            post_type_id
        FROM portfolios
        WHERE post_type_id IN (4,5)
        ORDER BY post_type_id, id
    """)

    rows = mcur.fetchall()

    created_gallery = 0
    created_video = 0
    skipped = 0
    missing_profiles = []

    for row in rows:
        # map old profile ID → new Profile.id
        pcur.execute("""
            SELECT id
            FROM "Profile"
            WHERE "legacyId" = %s
            LIMIT 1
        """, (row["profile_id"],))

        profile = pcur.fetchone()

        if not profile:
            missing_profiles.append({
                "legacy_profile_id": row["profile_id"],
                "legacy_portfolio_id": row["id"],
                "post_type_id": row["post_type_id"],
            })
            continue

        table = "Gallery" if row["post_type_id"] == 4 else "Video"

        pcur.execute(
            f'''
            SELECT id
            FROM "{table}"
            WHERE "legacyPortfolioId" = %s
            ''',
            (row["id"],)
        )

        if pcur.fetchone():
            skipped += 1
            continue

        pcur.execute(
            f'''
            INSERT INTO "{table}" (
                id,
                "profileId",
                "legacyPortfolioId",
                title,
                description,
                url,
                status,
                "sortOrder",
                "createdAt",
                "updatedAt"
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ''',
            (
                new_id(),
                profile["id"],
                row["id"],
                row["title"],
                row["description"],
                row["url"],
                row["status"] if row["status"] is not None else 1,
                0,
                row["created_at"],
                row["updated_at"],
            )
        )

        if table == "Gallery":
            created_gallery += 1
        else:
            created_video += 1

    # ---------------------------------------------------------
    # Verify counts
    # ---------------------------------------------------------

    pcur.execute('SELECT COUNT(*) AS total FROM "Gallery"')
    gallery_total = pcur.fetchone()["total"]

    pcur.execute('SELECT COUNT(*) AS total FROM "Video"')
    video_total = pcur.fetchone()["total"]

    print()
    print("==========================================")
    print("GALLERY / VIDEO MIGRATION")
    print("==========================================")
    print("Expected Gallery source:", 654)
    print("Expected Video source:  ", 24)
    print()
    print("Gallery created:        ", created_gallery)
    print("Video created:          ", created_video)
    print("Already existing:       ", skipped)
    print()
    print("Gallery destination:    ", gallery_total)
    print("Video destination:      ", video_total)
    print("Missing profile maps:   ", len(missing_profiles))
    print("==========================================")

    if missing_profiles:
        print("\nMissing mappings:")
        for item in missing_profiles:
            print(item)

        raise RuntimeError(
            "Migration stopped because some old profile IDs "
            "could not be mapped to PostgreSQL Profile.legacyId."
        )

    if gallery_total < 654:
        raise RuntimeError("Gallery destination count is below 654.")

    if video_total < 24:
        raise RuntimeError("Video destination count is below 24.")

    pg.commit()

    print("\nCOMMIT SUCCESSFUL.")
    print("Legacy MariaDB data was NOT deleted.")

except Exception:
    pg.rollback()
    raise

finally:
    mcur.close()
    mysql.close()
    pcur.close()
    pg.close()
