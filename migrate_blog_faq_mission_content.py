#!/usr/bin/env python3

import os
import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor

MYSQL_HOST = "13.53.83.153"
MYSQL_PORT = 3306
MYSQL_DB = "vbizme_app"
MYSQL_USER = "dbadmin"
MYSQL_PASSWORD = os.environ["VBIZME_MYSQL_PASSWORD"]

PG_DSN = os.environ["DATABASE_URL"].split("?")[0]

# MariaDB post_type_id -> PostgreSQL dedicated table
SECTIONS = {
    6:  ("Blog", "BlogDirect"),
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
    totals = {}

    for post_type_id, (label, table) in SECTIONS.items():

        mcur.execute("""
            SELECT
                id,
                profile_id,
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

        source = len(rows)
        with_content = 0
        matched = 0
        updated = 0
        already_populated = 0
        missing = []

        for row in rows:

            content = row["content"]

            if content is None or not str(content).strip():
                continue

            with_content += 1

            pcur.execute(
                f'''
                SELECT
                    id,
                    "profileId",
                    "legacyPostId",
                    description
                FROM "{table}"
                WHERE "legacyPostId" = %s
                LIMIT 1
                ''',
                (row["id"],)
            )

            target = pcur.fetchone()

            if not target:
                missing.append(row["id"])
                continue

            matched += 1

            # Do not overwrite a populated new-system description.
            existing = target["description"]

            if existing is not None and str(existing).strip():
                already_populated += 1
                continue

            pcur.execute(
                f'''
                UPDATE "{table}"
                SET
                    description = %s,
                    "updatedAt" = COALESCE(%s, "updatedAt")
                WHERE "legacyPostId" = %s
                  AND (
                        description IS NULL
                        OR BTRIM(description) = ''
                  )
                ''',
                (
                    content,
                    row["updated_at"],
                    row["id"],
                )
            )

            updated += pcur.rowcount

        totals[label] = {
            "source": source,
            "with_content": with_content,
            "matched": matched,
            "updated": updated,
            "already_populated": already_populated,
            "missing": missing,
        }

    print()
    print("=" * 68)
    print("BLOG / FAQ / MISSION CONTENT MIGRATION")
    print("=" * 68)

    failures = False

    for label, data in totals.items():
        print()
        print(label)
        print("-" * 68)
        print("MariaDB source rows:           ", data["source"])
        print("Source rows with content:      ", data["with_content"])
        print("PostgreSQL matches:            ", data["matched"])
        print("Descriptions updated:          ", data["updated"])
        print("Already populated (preserved): ", data["already_populated"])
        print("Missing legacyPostId mappings: ", len(data["missing"]))

        if data["missing"]:
            failures = True
            print("Missing IDs:", data["missing"][:50])

    if failures:
        raise RuntimeError(
            "Some source rows have no PostgreSQL legacyPostId match. "
            "Migration rolled back."
        )

    pg.commit()

    print()
    print("=" * 68)
    print("COMMIT SUCCESSFUL")
    print("=" * 68)
    print("MariaDB was NOT modified.")
    print("Existing non-empty PostgreSQL descriptions were NOT overwritten.")
    print("HTML content was preserved exactly.")

except Exception:
    pg.rollback()
    raise

finally:
    mcur.close()
    mysql.close()
    pcur.close()
    pg.close()
