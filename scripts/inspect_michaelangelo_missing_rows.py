#!/usr/bin/env python3

import os
import psycopg2
from psycopg2.extras import RealDictCursor

PROFILE_ID = "cmsuup13204ubcnkcdd5m3dgy"

STALE_IDS = [
    "cmsuupaxz05rfcnkcp7x5pvq4",
    "cmsuupcsy05whcnkcetmu49g0",
    "cmsuupf1m065ocnkc4cfjhyqn",
    "c3bb86634352443de945a79d2",
    "cf0831cb269d24e3b93b5ef4c",
    "caa817dd098d74c93b33798f2",
    "c557feddf5e3b44f2ad462327",
    "c201e9f94c126461eb68db89c",
]

pg = psycopg2.connect(os.environ["NEW_DATABASE_URL"])

try:
    with pg.cursor(cursor_factory=RealDictCursor) as c:

        print("=" * 80)
        print("1. PORTFOLIO TABLE STRUCTURE")
        print("=" * 80)

        c.execute("""
            SELECT
                column_name,
                data_type,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='Portfolio'
            ORDER BY ordinal_position
        """)

        for row in c.fetchall():
            print(dict(row))


        print()
        print("=" * 80)
        print("2. ATTACHMENT TABLE STRUCTURE")
        print("=" * 80)

        c.execute("""
            SELECT
                column_name,
                data_type,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='Attachment'
            ORDER BY ordinal_position
        """)

        for row in c.fetchall():
            print(dict(row))


        print()
        print("=" * 80)
        print("3. DO STALE ATTACHABLE IDs EXIST AS PORTFOLIOS?")
        print("=" * 80)

        c.execute("""
            SELECT *
            FROM "Portfolio"
            WHERE id = ANY(%s)
            ORDER BY id
        """, (STALE_IDS,))

        rows = c.fetchall()

        print("FOUND:", len(rows))

        for row in rows:
            print(dict(row))


        print()
        print("=" * 80)
        print("4. SEARCH STALE IDS IN TEXT COLUMNS")
        print("=" * 80)

        # Find every public table/text column where these IDs
        # might have survived from an earlier migration.

        c.execute("""
            SELECT
                table_name,
                column_name
            FROM information_schema.columns
            WHERE table_schema='public'
              AND data_type IN (
                    'text',
                    'character varying',
                    'character'
              )
            ORDER BY table_name,column_name
        """)

        columns = c.fetchall()

        for col in columns:

            table = col["table_name"]
            column = col["column_name"]

            # identifiers come from information_schema, not user input
            sql = f'''
                SELECT "{column}"::text AS value
                FROM "{table}"
                WHERE "{column}"::text = ANY(%s)
                LIMIT 20
            '''

            try:
                c.execute(sql, (STALE_IDS,))
                found = c.fetchall()

                if found:
                    print()
                    print(
                        f"MATCH {table}.{column}:",
                        len(found)
                    )

                    for item in found:
                        print(dict(item))

            except Exception:
                pg.rollback()


        print()
        print("=" * 80)
        print("5. ALL MICHAELANGELO PORTFOLIOS — FULL ROWS")
        print("=" * 80)

        c.execute("""
            SELECT *
            FROM "Portfolio"
            WHERE "profileId"=%s
            ORDER BY "createdAt", id
        """, (PROFILE_ID,))

        for row in c.fetchall():
            print(dict(row))


        print()
        print("=" * 80)
        print("6. MICHAELANGELO ATTACHMENTS AROUND TARGET IDS")
        print("=" * 80)

        c.execute("""
            SELECT *
            FROM "Attachment"
            WHERE "profileId"=%s
              AND (
                    "legacyId" IN (
                        858,1013,2419,4599,
                        5198,5199,5204,5205,5206
                    )
                    OR "attachableId" = ANY(%s)
              )
            ORDER BY "legacyId", "createdAt"
        """, (PROFILE_ID, STALE_IDS))

        for row in c.fetchall():
            print(dict(row))


        print()
        print("=" * 80)
        print("7. PORTFOLIOS WITH NULL LEGACY ID")
        print("=" * 80)

        c.execute("""
            SELECT *
            FROM "Portfolio"
            WHERE "profileId"=%s
              AND "legacyId" IS NULL
            ORDER BY "createdAt", id
        """, (PROFILE_ID,))

        rows = c.fetchall()

        print("COUNT:", len(rows))

        for row in rows:
            print(dict(row))


        print()
        print("READ ONLY — NOTHING CHANGED")

finally:
    pg.rollback()
    pg.close()
