#!/usr/bin/env python3

import os
import pymysql
import psycopg2
from collections import Counter, defaultdict
from psycopg2.extras import RealDictCursor


my = pymysql.connect(
    host=os.environ["OLD_MYSQL_HOST"],
    port=int(os.environ.get("OLD_MYSQL_PORT", "3306")),
    user=os.environ["OLD_MYSQL_USER"],
    password=os.environ["OLD_MYSQL_PASSWORD"],
    database=os.environ["OLD_MYSQL_DATABASE"],
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    ssl_disabled=True,
)

pg = psycopg2.connect(os.environ["NEW_DATABASE_URL"])


# ============================================================
# HELPERS
# ============================================================

def old_table_exists(table):
    with my.cursor() as c:
        c.execute("""
            SELECT COUNT(*) total
            FROM information_schema.tables
            WHERE table_schema=%s
              AND table_name=%s
        """, (
            os.environ["OLD_MYSQL_DATABASE"],
            table,
        ))
        return c.fetchone()["total"] > 0


def new_table_exists(table):
    with pg.cursor() as c:
        c.execute("""
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema='public'
                  AND table_name=%s
            )
        """, (table,))
        return c.fetchone()[0]


def new_column_exists(table, column):
    with pg.cursor() as c:
        c.execute("""
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema='public'
                  AND table_name=%s
                  AND column_name=%s
            )
        """, (table, column))
        return c.fetchone()[0]


def old_ids(table, where=None):
    sql = f"SELECT id FROM `{table}`"
    if where:
        sql += " WHERE " + where

    with my.cursor() as c:
        c.execute(sql)
        return {
            int(r["id"])
            for r in c.fetchall()
            if r["id"] is not None
        }


def new_legacy_ids(table, column="legacyId"):
    if (
        not new_table_exists(table)
        or not new_column_exists(table, column)
    ):
        return set()

    with pg.cursor() as c:
        c.execute(
            f'''
            SELECT "{column}"
            FROM "{table}"
            WHERE "{column}" IS NOT NULL
            '''
        )

        return {
            int(r[0])
            for r in c.fetchall()
        }


def compare(label, old_set, new_set):
    missing = sorted(old_set - new_set)

    print(
        f"{label:34} "
        f"OLD={len(old_set):6} "
        f"MAPPED={len(old_set & new_set):6} "
        f"MISSING={len(missing):6}"
    )

    if missing:
        print("   first missing:", missing[:30])

    return missing


failures = {}


print()
print("============================================================")
print("A. USER / VCARD IDENTITY")
print("============================================================")

old_users = old_ids("users")
new_users = new_legacy_ids("User")

old_profiles = old_ids("profiles")
new_profiles = new_legacy_ids("Profile")

failures["users"] = compare(
    "USERS",
    old_users,
    new_users,
)

failures["profiles"] = compare(
    "VCARDS / PROFILES",
    old_profiles,
    new_profiles,
)


with my.cursor() as c:
    c.execute("""
        SELECT
            u.id,
            u.name,
            u.email
        FROM users u
        LEFT JOIN profiles p
          ON p.user_id=u.id
        WHERE p.id IS NULL
        ORDER BY u.id
    """)

    without_profile = c.fetchall()

print()
print("OLD USERS WITHOUT OLD CARD:", len(without_profile))

for r in without_profile:
    print(r)


print()
print("============================================================")
print("B. CORE OLD BUSINESS DATA")
print("============================================================")

simple_maps = [
    ("addresses",             "Address",             "legacyId"),
    ("attachment_types",      "AttachmentType",      "legacyId"),
    ("cities",                "City",                "legacyId"),
    ("company_employees",     "CompanyEmployee",     "legacyId"),
    ("contacts",              "Contact",             "legacyId"),
    ("countries",             "Country",             "legacyId"),
    ("education",             "Education",           "legacyId"),
    ("event_logs",            "EventLog",            "legacyId"),
    ("experiences",           "Experience",          "legacyId"),
    ("genders",               "Gender",              "legacyId"),
    ("guest_user_data",       "GuestUserData",       "legacyId"),
    ("marital_statuses",      "MaritalStatus",       "legacyId"),
    ("packages",              "Package",             "legacyId"),
    ("package_features",      "PackageFeature",      "legacyId"),
    ("portfolios",            "Portfolio",           "legacyId"),
    ("posts",                 "Post",                "legacyId"),
    ("post_metas",            "PostMeta",            "legacyId"),
    ("professions",           "Profession",          "legacyId"),
    ("profile_settings",      "ProfileSetting",      "legacyId"),
    ("settings",              "Setting",             "legacyId"),
    ("states",                "State",               "legacyId"),
    ("statuses",              "Status",              "legacyId"),
    ("subscriptions",         "Subscription",        "legacyId"),
    ("transactions",          "Transaction",         "legacyId"),
    ("user_notes",            "UserNote",            "legacyId"),
    ("attachments",           "Attachment",          "legacyId"),
]

for old_table, new_table, legacy_col in simple_maps:

    if not old_table_exists(old_table):
        continue

    o = old_ids(old_table)
    n = new_legacy_ids(
        new_table,
        legacy_col,
    )

    missing = compare(
        old_table,
        o,
        n,
    )

    failures[old_table] = missing


print()
print("============================================================")
print("C. CARD-SCOPED SETTINGS")
print("============================================================")

old_card_settings = old_ids(
    "settings",
    "profile_id IS NOT NULL",
)

new_settings = new_legacy_ids(
    "Setting",
    "legacyId",
)

failures["card_settings"] = compare(
    "CARD SETTINGS",
    old_card_settings,
    new_settings,
)

with my.cursor() as c:
    c.execute("""
        SELECT COUNT(*) total
        FROM settings
        WHERE profile_id IS NULL
    """)

    global_settings = c.fetchone()["total"]

print(
    "OLD GLOBAL/NULL-PROFILE SETTINGS:",
    global_settings,
)


print()
print("============================================================")
print("D. SERVICES → SERVICE / CLIENT / REVIEW")
print("============================================================")

old_services = old_ids("services")

mapped_services = (
    new_legacy_ids(
        "Service",
        "legacyId",
    )
    | new_legacy_ids(
        "Client",
        "legacyServiceId",
    )
    | new_legacy_ids(
        "Review",
        "legacyServiceId",
    )
)

failures["services"] = compare(
    "SERVICES",
    old_services,
    mapped_services,
)


print()
print("============================================================")
print("E. SAVE CONTACT HISTORY")
print("============================================================")

with my.cursor() as c:
    c.execute("""
        SELECT
            id,
            profile_id,
            timestamp,
            created_at
        FROM event_logs
        WHERE LOWER(TRIM(event))='save_contact'
        ORDER BY id
    """)

    old_save_rows = c.fetchall()


with pg.cursor(
    cursor_factory=RealDictCursor
) as c:

    c.execute("""
        SELECT
            e.id,
            e."legacyId",
            e."profileId",
            p.id AS "joinedProfileId",
            p."legacyId" AS "profileLegacyId",
            p.name,
            p.slug
        FROM "EventLog" e

        LEFT JOIN "Profile" p
          ON p.id=e."profileId"

        WHERE e."eventType"=
            'save_contact_download'
    """)

    new_save_rows = c.fetchall()


old_save_ids = {
    int(r["id"])
    for r in old_save_rows
}

mapped_save_ids = {
    int(r["legacyId"])
    for r in new_save_rows
    if r["legacyId"] is not None
}

new_only_saves = [
    r
    for r in new_save_rows
    if r["legacyId"] is None
]

missing_save_ids = sorted(
    old_save_ids - mapped_save_ids
)

print(
    "OLD Save Contacts:",
    len(old_save_ids),
)

print(
    "OLD Save Contacts mapped:",
    len(old_save_ids & mapped_save_ids),
)

print(
    "Missing OLD Save Contacts:",
    len(missing_save_ids),
)

print(
    "NEW-only Save Contacts:",
    len(new_only_saves),
)

print(
    "ADMIN TOTAL SAVE CONTACTS:",
    len(new_save_rows),
)

failures["save_contacts"] = missing_save_ids


old_save_by_id = {
    int(r["id"]): r
    for r in old_save_rows
}

wrong_profile = []
missing_joined_profile = []
no_slug = []

for r in new_save_rows:

    legacy = r["legacyId"]

    if legacy is None:
        continue

    legacy = int(legacy)

    old = old_save_by_id.get(legacy)

    if not old:
        continue

    if r["joinedProfileId"] is None:
        missing_joined_profile.append({
            "eventLegacyId": legacy,
            "oldProfileId":
                old.get("profile_id"),
            "newProfileId":
                r.get("profileId"),
        })

        continue

    if (
        old.get("profile_id") is not None
        and r["profileLegacyId"] is not None
        and int(old["profile_id"])
            != int(r["profileLegacyId"])
    ):
        wrong_profile.append({
            "eventLegacyId": legacy,
            "oldProfileId":
                old["profile_id"],
            "newProfileLegacyId":
                r["profileLegacyId"],
            "slug":
                r["slug"],
        })

    if not r["slug"]:
        no_slug.append({
            "eventLegacyId": legacy,
            "oldProfileId":
                old.get("profile_id"),
            "newProfileId":
                r.get("profileId"),
            "profileLegacyId":
                r.get("profileLegacyId"),
            "name":
                r.get("name"),
        })


print()
print(
    "SAVE PROFILE MISMATCHES:",
    len(wrong_profile),
)

print(
    "SAVE EVENTS WITH NO JOINED PROFILE:",
    len(missing_joined_profile),
)

print(
    "SAVE EVENTS WITH NO SLUG:",
    len(no_slug),
)

if missing_joined_profile:
    print()
    print("NO JOINED PROFILE DETAILS:")
    for r in missing_joined_profile:
        print(r)

if no_slug:
    print()
    print("NO-SLUG SAVE DETAILS:")
    for r in no_slug:
        print(r)


# ------------------------------------------------------------
# Exact per-card Save Contact totals
# ------------------------------------------------------------

by_card = defaultdict(
    lambda: {
        "name": None,
        "slug": None,
        "old": 0,
        "new": 0,
        "total": 0,
    }
)

for r in new_save_rows:

    key = (
        r["joinedProfileId"]
        or "__ORPHAN__"
    )

    row = by_card[key]

    row["name"] = r["name"]
    row["slug"] = r["slug"]
    row["total"] += 1

    if r["legacyId"] is None:
        row["new"] += 1
    else:
        row["old"] += 1


print()
print("TOP SAVE CONTACT TOTALS BY CARD")

for r in sorted(
    by_card.values(),
    key=lambda x: -x["total"],
)[:40]:

    print(
        f"{str(r['slug'] or 'NO-SLUG'):40} "
        f"OLD={r['old']:4} "
        f"NEW={r['new']:3} "
        f"TOTAL={r['total']:4}"
    )


print()
print("============================================================")
print("F. CORPORATE ACCOUNTS")
print("============================================================")

with my.cursor() as c:
    c.execute("""
        SELECT
            id,
            user_id,
            name,
            provider
        FROM subscriptions
        WHERE LOWER(TRIM(COALESCE(name,'')))
                  = 'corporate'
           OR LOWER(TRIM(COALESCE(provider,'')))
                  = 'corporate'
        ORDER BY id
    """)

    corporate_subs = c.fetchall()


corporate_owner_ids = {
    int(r["user_id"])
    for r in corporate_subs
    if r["user_id"] is not None
}

corporate_sub_ids = {
    int(r["id"])
    for r in corporate_subs
}

print(
    "OLD CORPORATE SUBSCRIPTIONS:",
    len(corporate_sub_ids),
)

print(
    "OLD DISTINCT CORPORATE OWNERS:",
    len(corporate_owner_ids),
)

print(
    "CORPORATE OWNER USER IDs:",
    sorted(corporate_owner_ids),
)


new_sub_ids = new_legacy_ids(
    "Subscription",
    "legacyId",
)

missing_corp_subs = sorted(
    corporate_sub_ids - new_sub_ids
)

missing_corp_users = sorted(
    corporate_owner_ids - new_users
)

print(
    "Missing corporate subscriptions:",
    missing_corp_subs,
)

print(
    "Missing corporate owner users:",
    missing_corp_users,
)

failures["corporate_subscriptions"] = (
    missing_corp_subs
)

failures["corporate_users"] = (
    missing_corp_users
)


# Corporate roles in OLD
with my.cursor() as c:

    c.execute("""
        SELECT id, name
        FROM roles
        WHERE LOWER(name) IN (
            'corporate admin',
            'corporate user'
        )
        ORDER BY id
    """)

    corp_roles = c.fetchall()


role_name_by_id = {
    int(r["id"]): r["name"]
    for r in corp_roles
}

corp_role_counts = Counter()

corp_role_users = set()

if role_name_by_id:

    placeholders = ",".join(
        ["%s"] *
        len(role_name_by_id)
    )

    with my.cursor() as c:

        c.execute(
            f"""
            SELECT
                role_id,
                model_id
            FROM model_has_roles
            WHERE role_id IN (
                {placeholders}
            )
            """,
            tuple(role_name_by_id),
        )

        for r in c.fetchall():

            role_id = int(r["role_id"])
            user_id = int(r["model_id"])

            corp_role_counts[
                role_name_by_id[role_id]
            ] += 1

            corp_role_users.add(
                user_id
            )


print(
    "OLD CORPORATE ROLE COUNTS:",
    dict(corp_role_counts),
)

print(
    "OLD TOTAL CORPORATE-ROLE USERS:",
    len(corp_role_users),
)

print(
    "Corporate-role users missing in NEW:",
    sorted(corp_role_users - new_users),
)


# Show NEW role distribution for these old users
if (
    new_column_exists("User", "role")
    and corp_role_users
):

    with pg.cursor(
        cursor_factory=RealDictCursor
    ) as c:

        c.execute("""
            SELECT
                "legacyId",
                role
            FROM "User"
            WHERE "legacyId" = ANY(%s)
            ORDER BY "legacyId"
        """, (
            list(corp_role_users),
        ))

        rows = c.fetchall()

    print(
        "NEW ROLE DISTRIBUTION:",
        dict(
            Counter(
                str(r["role"])
                for r in rows
            )
        )
    )


print()
print("============================================================")
print("G. COMPANY / CORPORATE TEAM CARD RELATIONSHIPS")
print("============================================================")

with my.cursor() as c:

    c.execute("""
        SELECT
            id,
            user_id,
            company_id
        FROM company_employees
        ORDER BY id
    """)

    old_company_rows = c.fetchall()


old_company = {
    int(r["id"]): (
        int(r["user_id"]),
        int(r["company_id"]),
    )
    for r in old_company_rows
}


with pg.cursor(
    cursor_factory=RealDictCursor
) as c:

    c.execute("""
        SELECT
            ce."legacyId",
            employee."legacyId"
                AS "employeeLegacyId",
            company."legacyId"
                AS "companyLegacyId",
            ep.id
                AS "employeeProfileId",
            ep."legacyId"
                AS "employeeProfileLegacyId",
            ep.name
                AS "employeeCardName",
            ep.slug
                AS "employeeCardSlug"

        FROM "CompanyEmployee" ce

        LEFT JOIN "User" employee
          ON employee.id=ce."userId"

        LEFT JOIN "User" company
          ON company.id=ce."companyId"

        LEFT JOIN "Profile" ep
          ON ep."userId"=employee.id

        WHERE ce."legacyId" IS NOT NULL

        ORDER BY ce."legacyId"
    """)

    new_company_rows = c.fetchall()


new_company = {
    int(r["legacyId"]): r
    for r in new_company_rows
}


company_missing = []
company_wrong = []
employee_without_card = []

for old_id, pair in old_company.items():

    r = new_company.get(old_id)

    if not r:
        company_missing.append(old_id)
        continue

    expected_employee, expected_company = pair

    if (
        r["employeeLegacyId"]
            != expected_employee
        or r["companyLegacyId"]
            != expected_company
    ):
        company_wrong.append({
            "legacyId":
                old_id,
            "expectedEmployee":
                expected_employee,
            "actualEmployee":
                r["employeeLegacyId"],
            "expectedCompany":
                expected_company,
            "actualCompany":
                r["companyLegacyId"],
        })

    if r["employeeProfileId"] is None:
        employee_without_card.append(
            old_id
        )


print(
    "OLD company_employee rows:",
    len(old_company),
)

print(
    "Mapped company_employee rows:",
    len(new_company),
)

print(
    "Missing relationships:",
    company_missing,
)

print(
    "Wrong parent/employee mapping:",
    company_wrong,
)

print(
    "Employee relationships without card:",
    employee_without_card,
)

failures["company_employee"] = (
    company_missing
    + company_wrong
)


print()
print("============================================================")
print("H. MEET OUR TEAM")
print("============================================================")

with my.cursor() as c:

    c.execute("""
        SELECT
            id,
            profile_id,
            title
        FROM posts
        WHERE post_type_id=36
        ORDER BY id
    """)

    old_team = c.fetchall()


old_team_ids = {
    int(r["id"])
    for r in old_team
}

new_team_ids = new_legacy_ids(
    "TeamMember",
    "legacyPostId",
)

team_missing = sorted(
    old_team_ids - new_team_ids
)

print(
    "OLD Meet Our Team:",
    len(old_team_ids),
)

print(
    "Mapped TeamMember:",
    len(
        old_team_ids
        & new_team_ids
    ),
)

print(
    "Missing TeamMember IDs:",
    team_missing,
)

for r in old_team:
    print(r)

failures["team_members"] = (
    team_missing
)


print()
print("============================================================")
print("I. PUSH / NOTIFICATION / SKILL TABLE COUNTS")
print("============================================================")

special_counts = [
    (
        "push_notification_preferences",
        "PushNotificationPreference",
    ),
    (
        "push_subscriptions",
        "PushSubscription",
    ),
    (
        "skill_types",
        "SkillType",
    ),
]

for old_table, new_table in special_counts:

    if not old_table_exists(old_table):
        continue

    with my.cursor() as c:
        c.execute(
            f"SELECT COUNT(*) total FROM `{old_table}`"
        )
        oc = c.fetchone()["total"]

    nc = None

    if new_table_exists(new_table):
        with pg.cursor() as c:
            c.execute(
                f'SELECT COUNT(*) FROM "{new_table}"'
            )
            nc = c.fetchone()[0]

    print(
        f"{old_table:34} "
        f"OLD={oc} NEW={nc}"
    )


print()
print("============================================================")
print("J. FINAL HIGH-LEVEL STATUS")
print("============================================================")

critical_keys = [
    "users",
    "profiles",
    "save_contacts",
    "corporate_subscriptions",
    "corporate_users",
    "company_employee",
    "team_members",
    "card_settings",
    "services",
    "posts",
    "post_metas",
    "portfolios",
    "attachments",
    "profile_settings",
    "addresses",
]

critical_failures = []

for key in critical_keys:

    value = failures.get(key)

    if value:
        critical_failures.append(
            (key, len(value))
        )


if critical_failures:

    print("NOT 100% COMPLETE")

    for key, count in critical_failures:
        print(
            f"FAIL {key}: {count}"
        )

else:

    print(
        "ALL CRITICAL LEGACY-ID "
        "VERIFICATION CHECKS PASSED"
    )


print()
print("READ ONLY — NOTHING CHANGED")

my.close()
pg.close()
