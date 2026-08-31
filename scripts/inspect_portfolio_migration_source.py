#!/usr/bin/env python3

import os
from urllib.parse import urlparse, unquote

import pymysql

TARGET_PORTFOLIOS = [125, 433, 783, 912, 913, 914, 915, 916]
TARGET_ATTACHMENTS = [858, 1013, 2419, 4599, 5198, 5199, 5204, 5205, 5206]

u = urlparse(os.environ["LARAVEL_MYSQL_URL"])

db = pymysql.connect(
    host=u.hostname,
    port=u.port or 3306,
    user=unquote(u.username or ""),
    password=unquote(u.password or ""),
    database=(u.path or "").lstrip("/"),
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    ssl_disabled=True,
)

def section(name):
    print()
    print("=" * 90)
    print(name)
    print("=" * 90)

try:
    with db.cursor() as c:

        # ----------------------------------------------------
        # 1. FULL ATTACHMENTS SCHEMA
        # ----------------------------------------------------

        section("1. OLD MYSQL ATTACHMENTS TABLE SCHEMA")

        c.execute("SHOW CREATE TABLE attachments")

        row = c.fetchone()

        for k, v in row.items():
            print(f"{k}:")
            print(v)


        # ----------------------------------------------------
        # 2. FULL PORTFOLIOS SCHEMA
        # ----------------------------------------------------

        section("2. OLD MYSQL PORTFOLIOS TABLE SCHEMA")

        c.execute("SHOW CREATE TABLE portfolios")

        row = c.fetchone()

        for k, v in row.items():
            print(f"{k}:")
            print(v)


        # ----------------------------------------------------
        # 3. FULL TARGET PORTFOLIO ROWS
        # ----------------------------------------------------

        section("3. FULL OLD TARGET PORTFOLIO ROWS")

        placeholders = ",".join(["%s"] * len(TARGET_PORTFOLIOS))

        c.execute(
            f"""
            SELECT *
            FROM portfolios
            WHERE id IN ({placeholders})
            ORDER BY id
            """,
            TARGET_PORTFOLIOS,
        )

        for row in c.fetchall():
            print()
            print(dict(row))


        # ----------------------------------------------------
        # 4. FULL TARGET ATTACHMENT ROWS
        # ----------------------------------------------------

        section("4. FULL OLD TARGET ATTACHMENT ROWS")

        placeholders = ",".join(["%s"] * len(TARGET_ATTACHMENTS))

        c.execute(
            f"""
            SELECT *
            FROM attachments
            WHERE id IN ({placeholders})
            ORDER BY id
            """,
            TARGET_ATTACHMENTS,
        )

        for row in c.fetchall():
            print()
            print(dict(row))


        # ----------------------------------------------------
        # 5. ATTACHMENT TYPES
        # ----------------------------------------------------

        section("5. ATTACHMENT TYPE TABLES")

        c.execute("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name LIKE '%%attachment%%'
            ORDER BY table_name
        """)

        tables = [
            r["table_name"]
            for r in c.fetchall()
        ]

        print("Attachment-related tables:")
        print(tables)

        for table in tables:

            if table == "attachments":
                continue

            print()
            print("---", table, "---")

            try:
                c.execute(f"SELECT * FROM `{table}` LIMIT 100")

                for row in c.fetchall():
                    print(dict(row))

            except Exception as exc:
                print("ERROR:", exc)


        # ----------------------------------------------------
        # 6. FIND OTHER RANGO SPADER REFERENCES
        # ----------------------------------------------------

        section("6. SEARCH OLD DB FOR RANGO SPADER")

        c.execute("""
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND data_type IN (
                    'varchar',
                    'text',
                    'mediumtext',
                    'longtext',
                    'char'
              )
            ORDER BY table_name,column_name
        """)

        cols = c.fetchall()

        for col in cols:

            table = col["table_name"]
            column = col["column_name"]

            try:
                sql = (
                    f"SELECT `{column}` AS value "
                    f"FROM `{table}` "
                    f"WHERE `{column}` LIKE %s "
                    f"LIMIT 20"
                )

                c.execute(
                    sql,
                    ("%Rango Spader%",),
                )

                matches = c.fetchall()

                if matches:
                    print()
                    print(f"MATCH: {table}.{column}")

                    for match in matches:
                        print(dict(match))

            except Exception:
                pass


        section("DONE")
        print("READ ONLY — NOTHING CHANGED")

finally:
    db.close()
