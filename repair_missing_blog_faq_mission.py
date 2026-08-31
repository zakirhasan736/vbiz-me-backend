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

SECTIONS = {
    6: ("Blog", "BlogDirect"),
    13: ("FAQ", "Faq"),
    19: ("Mission Statement", "MissionStatement"),
}

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
    inserted = {6: 0, 13: 0, 19: 0}
    updated = {6: 0, 13: 0, 19: 0}
    preserved = {6: 0, 13: 0, 19: 0}
    missing_profiles = []

    for post_type_id, (label, table) in SECTIONS.items():

        mcur.execute("""
            SELECT
                id,
                profile_id,
                post_type_id,
                title,
                content,
                url,
                status,
                created_at,
                updated_at
            FROM posts
            WHERE post_type_id = %s
              AND deleted_at IS NULL
            ORDER BY id
        """, (post_type_id,))

        rows = mcur.fetchall()

        for row in rows:

            # Find corresponding PostgreSQL profile
            pcur.execute("""
                SELECT id
                FROM "Profile"
                WHERE "legacyId" = %s
                LIMIT 1
            """, (row["profile_id"],))

            profile = pcur.fetchone()

            if not profile:
                missing_profiles.append({
                    "post_id": row["id"],
                    "profile_id": row["profile_id"],
                    "post_type_id": post_type_id,
                })
                continue

            # Does destination record already exist?
            pcur.execute(
                f'''
                SELECT id, description
                FROM "{table}"
                WHERE "legacyPostId" = %s
                LIMIT 1
                ''',
                (row["id"],)
            )

            target = pcur.fetchone()

            # --------------------------------------------
            # Missing record -> create it
            # --------------------------------------------
            if not target:

                pcur.execute(
                    f'''
                    INSERT INTO "{table}" (
                        id,
                        "profileId",
                        "legacyPostId",
                        "legacyPostTypeId",
                        title,
                        description,
                        url,
                        "featuredImage",
                        status,
                        "sortOrder",
                        "deletedAt",
                        "createdAt",
                        "updatedAt"
                    )
                    VALUES (
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        NULL,
                        %s,
                        0,
                        NULL,
                        %s,
                        %s
                    )
                    ''',
                    (
                        str(uuid.uuid4()),
                        profile["id"],
                        row["id"],
                        post_type_id,
                        row["title"],
                        row["content"],
                        row["url"],
                        str(row["status"] if row["status"] is not None else 1),
                        row["created_at"],
                        row["updated_at"],
                    )
                )

                inserted[post_type_id] += 1
                continue

            # --------------------------------------------
            # Existing record -> restore missing content
            # --------------------------------------------
            old_content = row["content"]
            current_content = target["description"]

            if (
                old_content is not None
                and str(old_content).strip()
                and (
                    current_content is None
                    or not str(current_content).strip()
                )
            ):

                pcur.execute(
                    f'''
                    UPDATE "{table}"
                    SET
                        description = %s,
                        "updatedAt" = COALESCE(%s, "updatedAt")
                    WHERE "legacyPostId" = %s
                    ''',
                    (
                        old_content,
                        row["updated_at"],
                        row["id"],
                    )
                )

                updated[post_type_id] += pcur.rowcount

            else:
                preserved[post_type_id] += 1

    print()
    print("=" * 70)
    print("BLOG / FAQ / MISSION REPAIR")
    print("=" * 70)

    for post_type_id, (label, table) in SECTIONS.items():
        print()
        print(label)
        print("-" * 70)
        print("Inserted missing rows: ", inserted[post_type_id])
        print("Content restored:      ", updated[post_type_id])
        print("Preserved:             ", preserved[post_type_id])

    print()
    print("Missing profile mappings:", len(missing_profiles))

    if missing_profiles:
        print()
        for item in missing_profiles:
            print(item)

        raise RuntimeError(
            "Missing PostgreSQL profile mappings. "
            "Transaction rolled back."
        )

    # --------------------------------------------
    # Verification before commit
    # --------------------------------------------

    print()
    print("=" * 70)
    print("VERIFICATION")
    print("=" * 70)

    verification_failed = False

    for post_type_id, (label, table) in SECTIONS.items():

        mcur.execute("""
            SELECT COUNT(*) AS total
            FROM posts
            WHERE post_type_id = %s
              AND deleted_at IS NULL
        """, (post_type_id,))

        mysql_total = mcur.fetchone()["total"]

        pcur.execute(
            f'''
            SELECT COUNT(*) AS total
            FROM "{table}"
            WHERE "legacyPostTypeId" = %s
            ''',
            (post_type_id,)
        )

        pg_total = pcur.fetchone()["total"]

        pcur.execute(
            f'''
            SELECT COUNT(*) AS total
            FROM "{table}"
            WHERE "legacyPostTypeId" = %s
              AND (
                    description IS NULL
                    OR BTRIM(description) = ''
              )
            ''',
            (post_type_id,)
        )

        empty_descriptions = pcur.fetchone()["total"]

        print()
        print(label)
        print("MariaDB active rows:       ", mysql_total)
        print("PostgreSQL rows:           ", pg_total)
        print("Empty descriptions remain: ", empty_descriptions)

        if pg_total < mysql_total:
            verification_failed = True

    if verification_failed:
        raise RuntimeError(
            "Destination row count is lower than MariaDB. "
            "Transaction rolled back."
        )

    pg.commit()

    print()
    print("=" * 70)
    print("COMMIT SUCCESSFUL")
    print("=" * 70)
    print("MariaDB was NOT modified.")
    print("Existing PostgreSQL content was NOT overwritten.")
    print("HTML content was preserved.")

except Exception:
    pg.rollback()
    raise

finally:
    mcur.close()
    mysql.close()
    pcur.close()
    pg.close()
