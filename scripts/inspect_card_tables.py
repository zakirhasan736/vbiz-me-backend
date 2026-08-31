import os
import pymysql
import psycopg2

KEYWORDS = [
    "card", "ecard", "profile", "service", "review",
    "gallery", "portfolio", "setting", "tab", "nav",
    "video", "certificate", "license", "faq", "blog",
    "client", "social", "mission", "team", "public",
    "contact", "lead"
]

def interesting(name):
    n = name.lower()
    return any(k in n for k in KEYWORDS)

print("\n==============================================")
print("OLD MYSQL DATABASE")
print("==============================================")

mysql_conn = pymysql.connect(
    host=os.environ["OLD_MYSQL_HOST"],
    port=int(os.environ.get("OLD_MYSQL_PORT", "3306")),
    user=os.environ["OLD_MYSQL_USER"],
    password=os.environ["OLD_MYSQL_PASSWORD"],
    database=os.environ["OLD_MYSQL_DATABASE"],
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
)

with mysql_conn.cursor() as cur:
    cur.execute("SHOW TABLES")
    rows = cur.fetchall()

    key = list(rows[0].keys())[0] if rows else None
    tables = [r[key] for r in rows] if key else []

    print(f"Total MySQL tables: {len(tables)}")

    for table in tables:
        if not interesting(table):
            continue

        cur.execute(f"SELECT COUNT(*) AS cnt FROM `{table}`")
        count = cur.fetchone()["cnt"]

        cur.execute(f"DESCRIBE `{table}`")
        columns = cur.fetchall()

        print(f"\n--- {table} ({count} rows) ---")
        for col in columns:
            print(
                f"  {col['Field']} | "
                f"{col['Type']} | "
                f"NULL={col['Null']} | "
                f"KEY={col['Key']}"
            )

mysql_conn.close()

print("\n\n==============================================")
print("NEW POSTGRESQL DATABASE")
print("==============================================")

pg_conn = psycopg2.connect(os.environ["NEW_DATABASE_URL"])

with pg_conn.cursor() as cur:
    cur.execute("""
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
    """)

    tables = [r[0] for r in cur.fetchall()]

    print(f"Total PostgreSQL tables: {len(tables)}")

    for table in tables:
        if not interesting(table):
            continue

        cur.execute(
            'SELECT COUNT(*) FROM "{}"'.format(
                table.replace('"', '""')
            )
        )
        count = cur.fetchone()[0]

        cur.execute("""
            SELECT
                column_name,
                data_type,
                is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = %s
            ORDER BY ordinal_position
        """, (table,))

        columns = cur.fetchall()

        print(f"\n--- {table} ({count} rows) ---")
        for name, datatype, nullable in columns:
            print(
                f"  {name} | "
                f"{datatype} | "
                f"NULL={nullable}"
            )

pg_conn.close()

print("\n==============================================")
print("INSPECTION COMPLETE - NO DATA WAS CHANGED")
print("==============================================")
