import os
import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor

mysql_conn = pymysql.connect(
    host=os.environ["OLD_MYSQL_HOST"],
    port=int(os.environ.get("OLD_MYSQL_PORT", "3306")),
    user=os.environ["OLD_MYSQL_USER"],
    password=os.environ["OLD_MYSQL_PASSWORD"],
    database=os.environ["OLD_MYSQL_DATABASE"],
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
)

pg_conn = psycopg2.connect(os.environ["NEW_DATABASE_URL"])


def mysql_tables():
    with mysql_conn.cursor() as cur:
        cur.execute("SHOW TABLES")
        rows = cur.fetchall()
        key = list(rows[0].keys())[0] if rows else None
        return [r[key] for r in rows] if key else []


def mysql_columns(table):
    with mysql_conn.cursor() as cur:
        cur.execute(f"DESCRIBE `{table}`")
        return cur.fetchall()


def pg_tables_with_column(column):
    with pg_conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND column_name = %s
            ORDER BY table_name
        """, (column,))
        return [r["table_name"] for r in cur.fetchall()]


old_tables = mysql_tables()

print("\n==================================================")
print("ALL OLD MYSQL TABLES")
print("==================================================")

for t in old_tables:
    print(t)


print("\n==================================================")
print("POST TYPE / GENERIC TABLE DISCOVERY")
print("==================================================")

interesting = [
    "post_types",
    "post_type",
    "posts",
    "post_metas",
    "post_meta",
    "metas",
    "media",
    "attachments",
    "users",
    "profiles",
    "services",
    "portfolios",
    "settings",
    "profile_settings",
    "contacts",
]

for table in interesting:
    if table in old_tables:
        print(f"\n--- OLD {table} ---")
        for col in mysql_columns(table):
            print(
                col["Field"],
                "|",
                col["Type"],
                "| KEY=",
                col["Key"]
            )


for possible in ["post_types", "post_type"]:
    if possible in old_tables:
        print(f"\n==================================================")
        print(f"CONTENTS OF {possible}")
        print("==================================================")

        with mysql_conn.cursor() as cur:
            cur.execute(f"SELECT * FROM `{possible}` ORDER BY 1")
            for row in cur.fetchall():
                print(row)


for table in ["services", "portfolios"]:
    if table in old_tables:
        cols = [x["Field"] for x in mysql_columns(table)]

        if "post_type_id" in cols:
            print(f"\n==================================================")
            print(f"OLD {table.upper()} BY post_type_id")
            print("==================================================")

            with mysql_conn.cursor() as cur:
                cur.execute(f"""
                    SELECT
                        post_type_id,
                        COUNT(*) AS total,
                        MIN(created_at) AS first_created,
                        MAX(created_at) AS last_created,
                        MAX(updated_at) AS last_updated
                    FROM `{table}`
                    GROUP BY post_type_id
                    ORDER BY post_type_id
                """)

                for row in cur.fetchall():
                    print(row)


print("\n==================================================")
print("NEW POSTGRES LEGACY-ID DESTINATIONS")
print("==================================================")

legacy_columns = [
    "legacyId",
    "legacyServiceId",
    "legacyPortfolioId",
    "legacyPostId",
    "legacyPostTypeId",
]

for column in legacy_columns:
    tables = pg_tables_with_column(column)

    print(f"\n{column}:")
    for table in tables:
        with pg_conn.cursor() as cur:
            cur.execute(
                f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" IS NOT NULL'
            )
            count = cur.fetchone()[0]

        print(f"  {table}: {count}")


print("\n==================================================")
print("PROFILE LEGACY-ID COMPARISON")
print("==================================================")

with mysql_conn.cursor() as cur:
    cur.execute("""
        SELECT
            id,
            slug,
            name,
            created_at,
            updated_at
        FROM profiles
        ORDER BY id
    """)
    old_profiles = cur.fetchall()

with pg_conn.cursor(cursor_factory=RealDictCursor) as cur:
    cur.execute("""
        SELECT
            "legacyId",
            id,
            slug,
            name,
            "createdAt",
            "updatedAt"
        FROM "Profile"
        WHERE "legacyId" IS NOT NULL
    """)
    new_profiles = cur.fetchall()

new_by_legacy = {
    row["legacyId"]: row
    for row in new_profiles
}

missing = []
old_newer = []
new_newer = []

for old in old_profiles:
    new = new_by_legacy.get(old["id"])

    if not new:
        missing.append(old)
        continue

    old_updated = old.get("updated_at")
    new_updated = new.get("updatedAt")

    if old_updated and new_updated:
        # PostgreSQL timestamp is normally naive here.
        try:
            if getattr(old_updated, "tzinfo", None):
                old_updated = old_updated.replace(tzinfo=None)

            if getattr(new_updated, "tzinfo", None):
                new_updated = new_updated.replace(tzinfo=None)

            if old_updated > new_updated:
                old_newer.append((old, new))
            elif new_updated > old_updated:
                new_newer.append((old, new))
        except Exception:
            pass


print(f"OLD MySQL profiles: {len(old_profiles)}")
print(f"NEW PostgreSQL profiles with legacyId: {len(new_profiles)}")
print(f"Missing OLD profiles in NEW: {len(missing)}")
print(f"OLD timestamp newer: {len(old_newer)}")
print(f"NEW timestamp newer: {len(new_newer)}")


print("\n--- MISSING OLD PROFILES ---")

for row in missing:
    print({
        "legacyId": row["id"],
        "slug": row["slug"],
        "name": row["name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    })


print("\n--- OLD PROFILE NEWER THAN NEW PROFILE ---")

for old, new in old_newer:
    print({
        "legacyId": old["id"],
        "slug": old["slug"],
        "oldUpdated": old["updated_at"],
        "newUpdated": new["updatedAt"],
    })


print("\n==================================================")
print("DIRECT LEGACY COVERAGE")
print("==================================================")


def compare_simple(old_table, new_table, old_id="id", legacy_col="legacyId"):
    if old_table not in old_tables:
        return

    with mysql_conn.cursor() as cur:
        cur.execute(f"SELECT `{old_id}` FROM `{old_table}`")
        old_ids = {r[old_id] for r in cur.fetchall()}

    with pg_conn.cursor() as cur:
        cur.execute(
            f'SELECT "{legacy_col}" FROM "{new_table}" '
            f'WHERE "{legacy_col}" IS NOT NULL'
        )
        new_ids = {r[0] for r in cur.fetchall()}

    missing_ids = sorted(old_ids - new_ids)

    print(
        f"{old_table} -> {new_table}.{legacy_col}: "
        f"OLD={len(old_ids)}, "
        f"MAPPED={len(old_ids & new_ids)}, "
        f"MISSING={len(missing_ids)}"
    )

    if len(missing_ids) <= 50:
        print("  Missing legacy IDs:", missing_ids)
    else:
        print("  First 50 missing:", missing_ids[:50])


compare_simple("profiles", "Profile")
compare_simple("settings", "Setting")
compare_simple("profile_settings", "ProfileSetting")
compare_simple("contacts", "Contact")
compare_simple("services", "Service")
compare_simple("portfolios", "Portfolio")


print("\n==================================================")
print("SERVICE LEGACY IDS ACROSS ALL NEW TABLES")
print("==================================================")

service_tables = pg_tables_with_column("legacyServiceId")

with mysql_conn.cursor() as cur:
    cur.execute("SELECT id, post_type_id FROM services")
    old_services = cur.fetchall()

service_destinations = {}

for table in service_tables:
    with pg_conn.cursor() as cur:
        cur.execute(
            f'SELECT "legacyServiceId" FROM "{table}" '
            f'WHERE "legacyServiceId" IS NOT NULL'
        )

        for (legacy_id,) in cur.fetchall():
            service_destinations.setdefault(legacy_id, []).append(table)

# Service itself uses legacyId, not legacyServiceId.
with pg_conn.cursor() as cur:
    cur.execute(
        'SELECT "legacyId" FROM "Service" '
        'WHERE "legacyId" IS NOT NULL'
    )
    for (legacy_id,) in cur.fetchall():
        service_destinations.setdefault(legacy_id, []).append("Service")


service_stats = {}

for row in old_services:
    pt = row["post_type_id"]
    destinations = tuple(sorted(service_destinations.get(row["id"], [])))

    key = (pt, destinations)
    service_stats[key] = service_stats.get(key, 0) + 1

for (post_type_id, destinations), count in sorted(
    service_stats.items(),
    key=lambda x: (str(x[0][0]), str(x[0][1]))
):
    print({
        "post_type_id": post_type_id,
        "destinations": list(destinations),
        "count": count,
    })


print("\n==================================================")
print("PORTFOLIO LEGACY IDS ACROSS ALL NEW TABLES")
print("==================================================")

portfolio_tables = pg_tables_with_column("legacyPortfolioId")

with mysql_conn.cursor() as cur:
    cur.execute("SELECT id, post_type_id FROM portfolios")
    old_portfolios = cur.fetchall()

portfolio_destinations = {}

for table in portfolio_tables:
    with pg_conn.cursor() as cur:
        cur.execute(
            f'SELECT "legacyPortfolioId" FROM "{table}" '
            f'WHERE "legacyPortfolioId" IS NOT NULL'
        )

        for (legacy_id,) in cur.fetchall():
            portfolio_destinations.setdefault(
                legacy_id, []
            ).append(table)

with pg_conn.cursor() as cur:
    cur.execute(
        'SELECT "legacyId" FROM "Portfolio" '
        'WHERE "legacyId" IS NOT NULL'
    )
    for (legacy_id,) in cur.fetchall():
        portfolio_destinations.setdefault(
            legacy_id, []
        ).append("Portfolio")


portfolio_stats = {}

for row in old_portfolios:
    pt = row["post_type_id"]
    destinations = tuple(
        sorted(
            portfolio_destinations.get(
                row["id"], []
            )
        )
    )

    key = (pt, destinations)
    portfolio_stats[key] = portfolio_stats.get(
        key, 0
    ) + 1

for (post_type_id, destinations), count in sorted(
    portfolio_stats.items(),
    key=lambda x: (str(x[0][0]), str(x[0][1]))
):
    print({
        "post_type_id": post_type_id,
        "destinations": list(destinations),
        "count": count,
    })


mysql_conn.close()
pg_conn.close()

print("\n==================================================")
print("DEEP INSPECTION COMPLETE")
print("NO DATABASE DATA WAS CHANGED")
print("==================================================")
