#!/usr/bin/env python3

import os
import sys
import uuid
import pymysql
import psycopg2

from psycopg2 import sql
from psycopg2.extras import RealDictCursor


# ============================================================
# CONFIG
# ============================================================

MYSQL_HOST = "13.53.83.153"
MYSQL_PORT = 3306
MYSQL_DATABASE = "vbizme_app"
MYSQL_USER = "dbadmin"

MYSQL_PASSWORD = os.environ["VBIZME_MYSQL_PASSWORD"]
PG_DSN = os.environ["DATABASE_URL"].split("?")[0]

APPLY = "--apply" in sys.argv


# ============================================================
# LEGACY POST TYPE → DEDICATED POSTGRESQL TABLE
# ============================================================

SECTION_MAP = {
    6:  ("Blog", "BlogDirect"),
    7:  ("General Post", "GeneralPost"),
    8:  ("BBB Accreditation", "BBBAccreditation"),
    9:  ("Licensing", "Licensing"),
    10: ("DCP", "DCP"),
    11: ("Certificates Licenses", "CertificateLicense"),
    12: ("Insurance License", "InsuranceLicense"),
    13: ("FAQ", "Faq"),
    14: ("Calendar", "CalendarSection"),
    15: ("Property Listing", "PropertyListing"),
    16: ("About Me", "AboutMeDirect"),
    17: ("Events", "Event"),
    18: ("Media Press", "MediaPress"),
    19: ("Mission Statement", "MissionStatement"),
    20: ("2D Video Explainer", "VideoExplainer"),
    21: ("Menu", "MenuSection"),
    22: ("Why Choose Us", "WhyChooseUs"),
    23: ("Announcement", "AnnouncementDirect"),
    24: ("Join My Team", "JoinMyTeam"),
    25: ("Booking", "Booking"),
    26: ("Additional Services", "AdditionalService"),
    27: ("Video Links", "VideoLink"),
    28: ("Inventory", "Inventory"),
    29: ("Home Solar", "HomeSolar"),
    30: ("Resiliency Products", "ResiliencyProduct"),
    31: ("Breakfast", "Breakfast"),
    32: ("Lunch", "Lunch"),
    33: ("Dinner", "Dinner"),
    34: ("See Products", "Product"),
    35: ("Sales Person", "SalesPerson"),
    36: ("Meet Our Team", "TeamMember"),
}


# ============================================================
# CONNECTIONS
# ============================================================

mysql = pymysql.connect(
    host=MYSQL_HOST,
    port=MYSQL_PORT,
    user=MYSQL_USER,
    password=MYSQL_PASSWORD,
    database=MYSQL_DATABASE,
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    ssl_disabled=True,
)

pg = psycopg2.connect(PG_DSN)
pg.autocommit = False

mcur = mysql.cursor()
pcur = pg.cursor(cursor_factory=RealDictCursor)


# ============================================================
# HELPERS
# ============================================================

def new_id():
    return str(uuid.uuid4())


def pg_table_exists(table_name):
    pcur.execute(
        """
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = %s
        ) AS exists
        """,
        (table_name,),
    )

    return pcur.fetchone()["exists"]


def pg_columns(table_name):
    pcur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = %s
        """,
        (table_name,),
    )

    return {row["column_name"] for row in pcur.fetchall()}


def get_pg_profile_id(legacy_profile_id):
    pcur.execute(
        """
        SELECT id
        FROM "Profile"
        WHERE "legacyId" = %s
        LIMIT 1
        """,
        (legacy_profile_id,),
    )

    row = pcur.fetchone()

    if row:
        return row["id"]

    return None


def get_pg_post_media(legacy_post_id):
    """
    PostgreSQL Post already contains migrated/S3 media references.

    Prefer those over legacy MariaDB URLs so we do not accidentally
    overwrite a new S3 URL with an old storage URL.
    """

    pcur.execute(
        """
        SELECT
            "featuredImage",
            url
        FROM "Post"
        WHERE "legacyId" = %s
        LIMIT 1
        """,
        (legacy_post_id,),
    )

    row = pcur.fetchone()

    if not row:
        return {
            "featuredImage": None,
            "pgPostUrl": None,
        }

    return {
        "featuredImage": row.get("featuredImage"),
        "pgPostUrl": row.get("url"),
    }


def create_missing_generic_table(table_name):
    """
    Only used for mapped sections whose direct table does not yet exist,
    such as GeneralPost / InsuranceLicense / VideoExplainer.

    Existing canonical tables are NEVER recreated.
    """

    query = sql.SQL("""
        CREATE TABLE IF NOT EXISTS {} (
            id TEXT PRIMARY KEY,

            "profileId" TEXT NOT NULL,

            "legacyPostId" INTEGER,
            "legacyPostTypeId" INTEGER NOT NULL,

            title TEXT,
            description TEXT,
            url TEXT,
            "featuredImage" TEXT,

            status TEXT NOT NULL DEFAULT '1',
            "sortOrder" INTEGER NOT NULL DEFAULT 0,

            "deletedAt" TIMESTAMP(3),

            "createdAt" TIMESTAMP(3)
                NOT NULL DEFAULT CURRENT_TIMESTAMP,

            "updatedAt" TIMESTAMP(3)
                NOT NULL DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY ("profileId")
                REFERENCES "Profile"(id)
                ON UPDATE CASCADE
                ON DELETE CASCADE
        )
    """).format(sql.Identifier(table_name))

    pcur.execute(query)

    pcur.execute(
        sql.SQL("""
            CREATE UNIQUE INDEX IF NOT EXISTS {}
            ON {} ("legacyPostId")
        """).format(
            sql.Identifier(
                f"{table_name}_legacyPostId_key"
            ),
            sql.Identifier(table_name),
        )
    )

    pcur.execute(
        sql.SQL("""
            CREATE INDEX IF NOT EXISTS {}
            ON {} ("profileId")
        """).format(
            sql.Identifier(
                f"{table_name}_profileId_idx"
            ),
            sql.Identifier(table_name),
        )
    )


# ============================================================
# MAIN SYNC
# ============================================================

try:

    print()
    print("=" * 80)
    print("ALL LEGACY POST SECTIONS → DIRECT POSTGRESQL TABLES")
    print("MODE:", "APPLY" if APPLY else "DRY RUN")
    print("=" * 80)

    totals = {}

    all_missing_profiles = []
    all_missing_destinations = []

    # --------------------------------------------------------
    # Work through all PostType-backed sections
    # --------------------------------------------------------

    for post_type_id, (label, table_name) in SECTION_MAP.items():

        # ----------------------------------------------------
        # Source rows
        # ----------------------------------------------------

        mcur.execute(
            """
            SELECT
                id,
                profile_id,
                post_type_id,
                title,
                excerpt,
                content,
                url,
                status,
                deleted_at,
                created_at,
                updated_at
            FROM posts
            WHERE post_type_id = %s
              AND deleted_at IS NULL
            ORDER BY id
            """,
            (post_type_id,),
        )

        source_rows = mcur.fetchall()

        # ----------------------------------------------------
        # If there is no legacy data, report it.
        # Do not manufacture rows.
        # ----------------------------------------------------

        if not source_rows:

            totals[post_type_id] = {
                "label": label,
                "table": table_name,
                "source": 0,
                "matched": 0,
                "inserted": 0,
                "updated": 0,
                "preserved": 0,
                "missing_profiles": 0,
            }

            continue

        # ----------------------------------------------------
        # Destination table
        # ----------------------------------------------------

        if not pg_table_exists(table_name):

            if APPLY:
                create_missing_generic_table(table_name)
            else:
                all_missing_destinations.append(
                    (post_type_id, label, table_name)
                )

                totals[post_type_id] = {
                    "label": label,
                    "table": table_name,
                    "source": len(source_rows),
                    "matched": 0,
                    "inserted": 0,
                    "updated": 0,
                    "preserved": 0,
                    "missing_profiles": 0,
                }

                continue

        destination_columns = pg_columns(table_name)

        # Required architecture
        required = {
            "id",
            "profileId",
            "legacyPostId",
            "legacyPostTypeId",
        }

        missing_required = (
            required - destination_columns
        )

        if missing_required:

            raise RuntimeError(
                f'{table_name} is missing required columns: '
                f'{sorted(missing_required)}'
            )

        matched = 0
        inserted = 0
        updated = 0
        preserved = 0
        missing_profiles = []

        # ----------------------------------------------------
        # Sync every legacy post
        # ----------------------------------------------------

        for source in source_rows:

            profile_id = get_pg_profile_id(
                source["profile_id"]
            )

            if not profile_id:

                missing_profiles.append(
                    {
                        "post_id": source["id"],
                        "legacy_profile_id":
                            source["profile_id"],
                        "post_type_id":
                            post_type_id,
                        "destination":
                            table_name,
                    }
                )

                continue

            # ------------------------------------------------
            # Existing destination record?
            # ------------------------------------------------

            lookup = sql.SQL("""
                SELECT *
                FROM {}
                WHERE "legacyPostId" = %s
                LIMIT 1
            """).format(
                sql.Identifier(table_name)
            )

            pcur.execute(
                lookup,
                (source["id"],),
            )

            existing = pcur.fetchone()

            pg_media = get_pg_post_media(
                source["id"]
            )

            # ------------------------------------------------
            # FIELD MAPPING
            # ------------------------------------------------

            mapped = {
                "profileId": profile_id,

                "legacyPostId":
                    source["id"],

                "legacyPostTypeId":
                    post_type_id,

                "title":
                    source["title"],

                # IMPORTANT:
                # Legacy Laravel stores the real body here.
                "description":
                    source["content"],

                "url":
                    pg_media["pgPostUrl"]
                    or source["url"],

                # Preserve already-migrated S3 media.
                "featuredImage":
                    pg_media["featuredImage"],

                "status":
                    str(
                        source["status"]
                        if source["status"] is not None
                        else 1
                    ),

                "deletedAt":
                    source["deleted_at"],

                "createdAt":
                    source["created_at"],

                "updatedAt":
                    source["updated_at"],
            }

            # Only use columns that this direct table actually has.
            mapped = {
                key: value
                for key, value in mapped.items()
                if key in destination_columns
            }

            # ------------------------------------------------
            # INSERT missing destination
            # ------------------------------------------------

            if not existing:

                if not APPLY:
                    inserted += 1
                    continue

                insert_values = {
                    "id": new_id(),
                    **mapped,
                }

                columns = list(
                    insert_values.keys()
                )

                query = sql.SQL("""
                    INSERT INTO {} ({})
                    VALUES ({})
                """).format(
                    sql.Identifier(table_name),

                    sql.SQL(", ").join(
                        sql.Identifier(c)
                        for c in columns
                    ),

                    sql.SQL(", ").join(
                        sql.Placeholder()
                        for _ in columns
                    ),
                )

                pcur.execute(
                    query,
                    [
                        insert_values[c]
                        for c in columns
                    ],
                )

                inserted += 1
                continue

            matched += 1

            # ------------------------------------------------
            # UPDATE existing destination
            #
            # Sync authoritative legacy fields.
            #
            # featuredImage is only replaced when we actually have
            # a migrated PostgreSQL Post/S3 reference.
            # ------------------------------------------------

            update_fields = {}

            for field, value in mapped.items():

                if field in {
                    "profileId",
                    "legacyPostId",
                    "legacyPostTypeId",
                }:
                    # Keep identity links authoritative.
                    update_fields[field] = value
                    continue

                if field == "featuredImage":

                    if value:
                        update_fields[field] = value

                    continue

                # MariaDB title/content/status/timestamps
                # are authoritative legacy values.
                update_fields[field] = value

            if not update_fields:
                preserved += 1
                continue

            if not APPLY:
                updated += 1
                continue

            assignments = []

            values = []

            for field, value in update_fields.items():

                assignments.append(
                    sql.SQL("{} = %s").format(
                        sql.Identifier(field)
                    )
                )

                values.append(value)

            values.append(
                source["id"]
            )

            update_query = sql.SQL("""
                UPDATE {}
                SET {}
                WHERE "legacyPostId" = %s
            """).format(
                sql.Identifier(table_name),

                sql.SQL(", ").join(
                    assignments
                ),
            )

            pcur.execute(
                update_query,
                values,
            )

            updated += pcur.rowcount

        all_missing_profiles.extend(
            missing_profiles
        )

        totals[post_type_id] = {
            "label": label,
            "table": table_name,
            "source": len(source_rows),
            "matched": matched,
            "inserted": inserted,
            "updated": updated,
            "preserved": preserved,
            "missing_profiles":
                len(missing_profiles),
        }


    # ========================================================
    # REPORT
    # ========================================================

    print()
    print("=" * 80)
    print("SECTION RECONCILIATION")
    print("=" * 80)

    for post_type_id in sorted(SECTION_MAP):

        info = totals[post_type_id]

        print()
        print(
            f'{post_type_id:>2} '
            f'{info["label"]}'
        )

        print(
            f'   table:            '
            f'{info["table"]}'
        )

        print(
            f'   MariaDB source:   '
            f'{info["source"]}'
        )

        print(
            f'   existing matched: '
            f'{info["matched"]}'
        )

        print(
            f'   missing/inserted: '
            f'{info["inserted"]}'
        )

        print(
            f'   updated:          '
            f'{info["updated"]}'
        )

        print(
            f'   missing profiles: '
            f'{info["missing_profiles"]}'
        )


    # ========================================================
    # SAFETY CHECK
    # ========================================================

    if all_missing_profiles:

        print()
        print("=" * 80)
        print("ERROR: MISSING PROFILE MAPPINGS")
        print("=" * 80)

        for item in all_missing_profiles[:100]:
            print(item)

        raise RuntimeError(
            "Some MariaDB posts cannot be mapped to "
            "PostgreSQL Profile.legacyId."
        )


    if all_missing_destinations and not APPLY:

        print()
        print("=" * 80)
        print("DIRECT TABLES MISSING")
        print("=" * 80)

        for item in all_missing_destinations:
            print(
                f'{item[0]} {item[1]} '
                f'→ {item[2]}'
            )

        print()
        print(
            "These will only be created in APPLY mode "
            "when they actually have source rows."
        )


    # ========================================================
    # FINAL VERIFICATION WHEN APPLYING
    # ========================================================

    if APPLY:

        print()
        print("=" * 80)
        print("FINAL DATABASE VERIFICATION")
        print("=" * 80)

        failures = []

        for post_type_id, (
            label,
            table_name
        ) in SECTION_MAP.items():

            source_count = (
                totals[post_type_id]["source"]
            )

            if source_count == 0:
                print(
                    f'{post_type_id:>2} '
                    f'{label}: '
                    f'NO SOURCE DATA'
                )
                continue

            pcur.execute(
                sql.SQL("""
                    SELECT COUNT(*) AS total
                    FROM {}
                    WHERE "legacyPostTypeId" = %s
                """).format(
                    sql.Identifier(table_name)
                ),
                (post_type_id,),
            )

            destination_count = (
                pcur.fetchone()["total"]
            )

            # Count mapped source IDs missing destination.
            mcur.execute(
                """
                SELECT id
                FROM posts
                WHERE post_type_id = %s
                  AND deleted_at IS NULL
                """,
                (post_type_id,),
            )

            source_ids = [
                r["id"]
                for r in mcur.fetchall()
            ]

            missing_ids = []

            if source_ids:

                pcur.execute(
                    sql.SQL("""
                        SELECT "legacyPostId"
                        FROM {}
                        WHERE "legacyPostId" = ANY(%s)
                    """).format(
                        sql.Identifier(
                            table_name
                        )
                    ),
                    (source_ids,),
                )

                found_ids = {
                    r["legacyPostId"]
                    for r in pcur.fetchall()
                }

                missing_ids = [
                    x
                    for x in source_ids
                    if x not in found_ids
                ]

            print(
                f'{post_type_id:>2} '
                f'{label}: '
                f'source={source_count}, '
                f'destination={destination_count}, '
                f'missing={len(missing_ids)}'
            )

            if missing_ids:

                failures.append(
                    {
                        "post_type":
                            post_type_id,
                        "label":
                            label,
                        "missing_ids":
                            missing_ids,
                    }
                )

        if failures:

            print()
            print("VERIFICATION FAILED")

            for failure in failures:
                print(failure)

            raise RuntimeError(
                "Direct-section verification failed."
            )

        pg.commit()

        print()
        print("=" * 80)
        print("COMMIT SUCCESSFUL")
        print("=" * 80)

        print()
        print(
            "All available MariaDB Post-backed "
            "section records are reconciled."
        )

        print(
            "MariaDB was NOT modified."
        )

        print(
            "Post/PostType were NOT deleted."
        )

        print(
            "Existing migrated S3 featured-image "
            "references were preserved."
        )

    else:

        pg.rollback()

        print()
        print("=" * 80)
        print("DRY RUN COMPLETE")
        print("=" * 80)

        print()
        print("Nothing was modified.")

        print()
        print(
            "After reviewing the report run:"
        )

        print(
            "python3 sync_all_post_sections.py --apply"
        )


except Exception:

    pg.rollback()

    print()
    print("TRANSACTION ROLLED BACK.")

    raise


finally:

    mcur.close()
    mysql.close()

    pcur.close()
    pg.close()
