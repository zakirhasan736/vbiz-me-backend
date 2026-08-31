import os
from collections import defaultdict

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


# --------------------------------------------------
# OLD POST TYPES
# --------------------------------------------------

with mysql_conn.cursor() as cur:
    cur.execute("""
        SELECT id, name, title
        FROM post_types
        ORDER BY id
    """)
    post_types = {
        r["id"]: r
        for r in cur.fetchall()
    }


# --------------------------------------------------
# NEW PROFILE LEGACY MAP
# --------------------------------------------------

with pg_conn.cursor(cursor_factory=RealDictCursor) as cur:
    cur.execute("""
        SELECT
            id,
            "legacyId",
            slug,
            name,
            "updatedAt",
            "userId",
            "companyUserId"
        FROM "Profile"
        WHERE "legacyId" IS NOT NULL
    """)
    new_profiles = {
        r["legacyId"]: dict(r)
        for r in cur.fetchall()
    }


# --------------------------------------------------
# OLD PROFILES
# --------------------------------------------------

with mysql_conn.cursor() as cur:
    cur.execute("""
        SELECT
            id,
            user_id,
            company_user_id,
            name,
            slug,
            email,
            created_at,
            updated_at
        FROM profiles
        ORDER BY id
    """)
    old_profiles = cur.fetchall()


missing_profiles = []
old_newer_profiles = []

for old in old_profiles:
    new = new_profiles.get(old["id"])

    if not new:
        missing_profiles.append(old)
        continue

    old_updated = old["updated_at"]
    new_updated = new["updatedAt"]

    if old_updated and new_updated:
        if getattr(old_updated, "tzinfo", None):
            old_updated = old_updated.replace(tzinfo=None)
        if getattr(new_updated, "tzinfo", None):
            new_updated = new_updated.replace(tzinfo=None)

        if old_updated > new_updated:
            old_newer_profiles.append(old)


candidate_ids = {
    r["id"]
    for r in missing_profiles + old_newer_profiles
}


print("\n==================================================")
print("CARD SYNC CANDIDATES")
print("==================================================")

for p in missing_profiles:
    print({
        "type": "MISSING_PROFILE",
        "legacyId": p["id"],
        "slug": p["slug"],
        "name": p["name"],
        "user_id": p["user_id"],
        "company_user_id": p["company_user_id"],
        "updated_at": p["updated_at"],
    })

for p in old_newer_profiles:
    print({
        "type": "OLD_PROFILE_NEWER",
        "legacyId": p["id"],
        "slug": p["slug"],
        "name": p["name"],
        "user_id": p["user_id"],
        "company_user_id": p["company_user_id"],
        "updated_at": p["updated_at"],
    })


# --------------------------------------------------
# USER RELATIONSHIP CHECK
# --------------------------------------------------

print("\n==================================================")
print("USER MAPPING FOR CANDIDATE CARDS")
print("==================================================")

old_user_ids = set()

for p in missing_profiles + old_newer_profiles:
    if p["user_id"]:
        old_user_ids.add(p["user_id"])
    if p["company_user_id"]:
        old_user_ids.add(p["company_user_id"])


if old_user_ids:
    placeholders = ",".join(["%s"] * len(old_user_ids))

    with mysql_conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id, name, email, created_at, updated_at
            FROM users
            WHERE id IN ({placeholders})
            ORDER BY id
            """,
            tuple(sorted(old_user_ids)),
        )
        old_users = cur.fetchall()

    with pg_conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT id, "legacyId", name, email
            FROM "User"
            WHERE "legacyId" = ANY(%s)
        """, (list(old_user_ids),))

        new_users = {
            r["legacyId"]: dict(r)
            for r in cur.fetchall()
        }

    for user in old_users:
        mapped = new_users.get(user["id"])

        print({
            "oldUserId": user["id"],
            "name": user["name"],
            "email": user["email"],
            "mappedInNew": bool(mapped),
            "newUserId": mapped["id"] if mapped else None,
        })


# --------------------------------------------------
# REFERENCE ID MAPPING
# --------------------------------------------------

print("\n==================================================")
print("REFERENCE TABLE COVERAGE")
print("==================================================")

reference_pairs = [
    ("professions", "Profession", "profession_id"),
    ("genders", "Gender", "gender_id"),
    ("marital_statuses", "MaritalStatus", "marital_status_id"),
]

for old_table, new_table, profile_column in reference_pairs:

    with mysql_conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT DISTINCT `{profile_column}` AS legacy_id
            FROM profiles
            WHERE id IN ({','.join(['%s'] * len(candidate_ids))})
              AND `{profile_column}` IS NOT NULL
            """,
            tuple(sorted(candidate_ids)),
        )

        needed = {
            r["legacy_id"]
            for r in cur.fetchall()
        }

    if not needed:
        continue

    with pg_conn.cursor() as cur:
        cur.execute(
            f'''
            SELECT "legacyId"
            FROM "{new_table}"
            WHERE "legacyId" = ANY(%s)
            ''',
            (list(needed),),
        )

        mapped = {r[0] for r in cur.fetchall()}

    print({
        "reference": old_table,
        "needed": sorted(needed),
        "mapped": sorted(mapped),
        "missing": sorted(needed - mapped),
    })


# --------------------------------------------------
# NEW TABLES WITH legacyPostId
# --------------------------------------------------

with pg_conn.cursor() as cur:
    cur.execute("""
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'legacyPostId'
        ORDER BY table_name
    """)

    direct_post_tables = [
        r[0]
        for r in cur.fetchall()
    ]


post_destinations = defaultdict(list)

for table in direct_post_tables:
    with pg_conn.cursor() as cur:
        cur.execute(
            f'''
            SELECT "legacyPostId"
            FROM "{table}"
            WHERE "legacyPostId" IS NOT NULL
            '''
        )

        for row in cur.fetchall():
            post_destinations[row[0]].append(table)


# Generic Post legacy IDs
with pg_conn.cursor() as cur:
    cur.execute("""
        SELECT "legacyId"
        FROM "Post"
        WHERE "legacyId" IS NOT NULL
    """)

    for row in cur.fetchall():
        post_destinations[row[0]].append("Post")


# --------------------------------------------------
# OLD POSTS
# --------------------------------------------------

with mysql_conn.cursor() as cur:
    cur.execute("""
        SELECT
            id,
            profile_id,
            post_type_id,
            title,
            status,
            created_at,
            updated_at,
            deleted_at
        FROM posts
        ORDER BY id
    """)

    old_posts = cur.fetchall()


print("\n==================================================")
print("GLOBAL POST TYPE -> NEW DESTINATION MAPPING")
print("==================================================")

mapping_stats = defaultdict(int)

for post in old_posts:
    destinations = tuple(
        sorted(post_destinations.get(post["id"], []))
    )

    mapping_stats[
        (
            post["post_type_id"],
            destinations
        )
    ] += 1


for (post_type_id, destinations), count in sorted(
    mapping_stats.items(),
    key=lambda x: (x[0][0], str(x[0][1]))
):
    pt = post_types.get(post_type_id, {})

    print({
        "post_type_id": post_type_id,
        "name": pt.get("name"),
        "title": pt.get("title"),
        "destinations": list(destinations),
        "count": count,
    })


# --------------------------------------------------
# CANDIDATE CARD GRAPH
# --------------------------------------------------

print("\n==================================================")
print("FULL OLD DATA GRAPH FOR CANDIDATE CARDS")
print("==================================================")


def count_rows(table, profile_id):
    with mysql_conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT COUNT(*) AS total
            FROM `{table}`
            WHERE profile_id = %s
            """,
            (profile_id,),
        )

        return cur.fetchone()["total"]


for profile in missing_profiles + old_newer_profiles:

    pid = profile["id"]

    print("\n--------------------------------------------------")
    print(
        f"{profile['name']} "
        f"({profile['slug']}) "
        f"legacyId={pid}"
    )
    print("--------------------------------------------------")

    for table in [
        "settings",
        "profile_settings",
        "contacts",
        "services",
        "portfolios",
        "posts",
    ]:
        print(
            f"{table}: "
            f"{count_rows(table, pid)}"
        )

    with mysql_conn.cursor() as cur:
        cur.execute("""
            SELECT
                post_type_id,
                COUNT(*) AS total
            FROM services
            WHERE profile_id = %s
            GROUP BY post_type_id
            ORDER BY post_type_id
        """, (pid,))

        for row in cur.fetchall():
            pt = post_types.get(
                row["post_type_id"], {}
            )

            print({
                "section": "services",
                "post_type_id": row["post_type_id"],
                "name": pt.get("name"),
                "count": row["total"],
            })

    with mysql_conn.cursor() as cur:
        cur.execute("""
            SELECT
                post_type_id,
                COUNT(*) AS total
            FROM portfolios
            WHERE profile_id = %s
            GROUP BY post_type_id
            ORDER BY post_type_id
        """, (pid,))

        for row in cur.fetchall():
            pt = post_types.get(
                row["post_type_id"], {}
            )

            print({
                "section": "portfolios",
                "post_type_id": row["post_type_id"],
                "name": pt.get("name"),
                "count": row["total"],
            })

    with mysql_conn.cursor() as cur:
        cur.execute("""
            SELECT
                post_type_id,
                COUNT(*) AS total
            FROM posts
            WHERE profile_id = %s
            GROUP BY post_type_id
            ORDER BY post_type_id
        """, (pid,))

        for row in cur.fetchall():
            pt = post_types.get(
                row["post_type_id"], {}
            )

            print({
                "section": "posts",
                "post_type_id": row["post_type_id"],
                "name": pt.get("name"),
                "count": row["total"],
            })


# --------------------------------------------------
# SETTINGS COVERAGE PER CANDIDATE
# --------------------------------------------------

print("\n==================================================")
print("SETTING COVERAGE PER CARD")
print("==================================================")

for profile in missing_profiles + old_newer_profiles:

    old_pid = profile["id"]
    new_profile = new_profiles.get(old_pid)

    with mysql_conn.cursor() as cur:
        cur.execute("""
            SELECT id, `key`, value, updated_at
            FROM settings
            WHERE profile_id = %s
        """, (old_pid,))

        old_settings = cur.fetchall()

    old_setting_ids = {
        s["id"]
        for s in old_settings
    }

    mapped_ids = set()

    if old_setting_ids:
        with pg_conn.cursor() as cur:
            cur.execute("""
                SELECT "legacyId"
                FROM "Setting"
                WHERE "legacyId" = ANY(%s)
            """, (list(old_setting_ids),))

            mapped_ids = {
                r[0]
                for r in cur.fetchall()
            }

    print({
        "profileLegacyId": old_pid,
        "slug": profile["slug"],
        "oldSettings": len(old_setting_ids),
        "mappedSettings": len(mapped_ids),
        "missingSettings": len(
            old_setting_ids - mapped_ids
        ),
    })


mysql_conn.close()
pg_conn.close()

print("\n==================================================")
print("FINAL INSPECTION COMPLETE")
print("NO DATA WAS CHANGED")
print("==================================================")
