import os
import getpass
from collections import defaultdict

import pymysql
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import RealDictCursor

load_dotenv(".env")

OLD_PROFILE_ID = 91

dburl = os.getenv("DATABASE_URL")
if not dburl:
    raise RuntimeError("DATABASE_URL missing from .env")

dburl = dburl.split("?")[0]

print("Enter OLD MySQL password.")
old_password = getpass.getpass("Old MySQL password: ")

old = pymysql.connect(
    host="13.53.83.153",
    port=3306,
    user="dbadmin",
    password=old_password,
    database="vbizme_app",
    cursorclass=pymysql.cursors.DictCursor,
    ssl_disabled=True,
)

new = psycopg2.connect(dburl)

try:
    # ============================================================
    # OLD PORTFOLIOS
    # ============================================================

    with old.cursor() as c:

        c.execute("""
            SELECT *
            FROM post_types
            ORDER BY id
        """)
        post_types = {
            r["id"]: r
            for r in c.fetchall()
        }

        c.execute("""
            SELECT *
            FROM attachment_types
            ORDER BY id
        """)
        attachment_types = {
            r["id"]: r
            for r in c.fetchall()
        }

        c.execute("""
            SELECT
                id,
                title,
                description,
                status,
                profile_id,
                post_type_id,
                url,
                created_at,
                updated_at
            FROM portfolios
            WHERE profile_id = %s
            ORDER BY id
        """, (OLD_PROFILE_ID,))

        portfolios = c.fetchall()

        portfolio_ids = [p["id"] for p in portfolios]

        if not portfolio_ids:
            raise RuntimeError("No old portfolios found for profile 91")

        placeholders = ",".join(["%s"] * len(portfolio_ids))

        c.execute(f"""
            SELECT *
            FROM attachments
            WHERE attachmentable_type = 'App\\\\Models\\\\Portfolio'
              AND attachmentable_id IN ({placeholders})
            ORDER BY attachmentable_id, attachment_type_id, id
        """, portfolio_ids)

        old_attachments = c.fetchall()

        # Find every duplicate filename globally.
        names = sorted({
            a["doc_name"]
            for a in old_attachments
            if a.get("doc_name")
        })

        duplicates_by_name = defaultdict(list)

        for name in names:
            c.execute("""
                SELECT
                    a.id,
                    a.attachmentable_id,
                    a.attachment_type_id,
                    a.doc_name,
                    a.created_at,
                    p.profile_id,
                    p.title,
                    p.post_type_id
                FROM attachments a
                JOIN portfolios p
                  ON p.id = a.attachmentable_id
                WHERE a.attachmentable_type = 'App\\\\Models\\\\Portfolio'
                  AND a.doc_name = %s
                ORDER BY a.id
            """, (name,))

            duplicates_by_name[name] = c.fetchall()

    # ============================================================
    # NEW PORTFOLIOS
    # ============================================================

    legacy_portfolio_ids = [p["id"] for p in portfolios]
    legacy_attachment_ids = [a["id"] for a in old_attachments]

    # Add duplicate attachment legacy IDs because they may provide
    # recoverable S3 sources.
    recovery_legacy_ids = set(legacy_attachment_ids)

    for rows in duplicates_by_name.values():
        for r in rows:
            recovery_legacy_ids.add(r["id"])

    with new.cursor(cursor_factory=RealDictCursor) as c:

        c.execute("""
            SELECT
                id,
                "legacyId",
                "profileId",
                title,
                "imageUrl",
                "attachmentUrl",
                "attachmentName"
            FROM "Portfolio"
            WHERE "legacyId" = ANY(%s)
            ORDER BY "legacyId"
        """, (legacy_portfolio_ids,))

        new_portfolios = {
            r["legacyId"]: dict(r)
            for r in c.fetchall()
        }

        c.execute("""
            SELECT
                id,
                "legacyId",
                "attachableId",
                "attachableType",
                "docName",
                url,
                "publicId",
                bytes,
                "resourceType",
                format,
                extension,
                "mimeType"
            FROM "Attachment"
            WHERE "legacyId" = ANY(%s)
            ORDER BY "legacyId"
        """, (list(recovery_legacy_ids),))

        new_attachments = {
            r["legacyId"]: dict(r)
            for r in c.fetchall()
        }

    # ============================================================
    # REPORT
    # ============================================================

    old_attachments_by_portfolio = defaultdict(list)

    for a in old_attachments:
        old_attachments_by_portfolio[a["attachmentable_id"]].append(a)

    print()
    print("=" * 120)
    print("MICHAELANGELO — COMPLETE OLD -> NEW PORTFOLIO MEDIA AUDIT")
    print("=" * 120)

    print("OLD PROFILE:", OLD_PROFILE_ID)
    print("OLD PORTFOLIOS:", len(portfolios))
    print("OLD PORTFOLIO ATTACHMENTS:", len(old_attachments))
    print()

    missing_portfolios = []
    missing_attachments = []
    broken_media = []
    relationship_errors = []
    recoverable = []

    for p in portfolios:

        legacy_pid = p["id"]
        np = new_portfolios.get(legacy_pid)

        print()
        print("#" * 120)
        print(
            f'PORTFOLIO {legacy_pid} | '
            f'TITLE={p["title"]!r} | '
            f'POST_TYPE_ID={p["post_type_id"]} | '
            f'OLD URL={p["url"]!r}'
        )

        pt = post_types.get(p["post_type_id"])
        if pt:
            print("POST TYPE ROW:", pt)

        if not np:
            print("NEW PORTFOLIO: *** MISSING ***")
            missing_portfolios.append(legacy_pid)
            continue

        print("NEW PORTFOLIO ID:", np["id"])
        print("NEW imageUrl:", np["imageUrl"])
        print("NEW attachmentUrl:", np["attachmentUrl"])
        print("NEW attachmentName:", np["attachmentName"])

        attachments = old_attachments_by_portfolio.get(legacy_pid, [])

        if not attachments:
            print("OLD ATTACHMENTS: NONE")
            continue

        for oa in attachments:

            aid = oa["id"]
            na = new_attachments.get(aid)

            print()
            print("    " + "-" * 110)
            print("    OLD ATTACHMENT:", aid)
            print("    ATTACH TYPE ID:", oa["attachment_type_id"])

            at = attachment_types.get(oa["attachment_type_id"])
            if at:
                print("    ATTACH TYPE ROW:", at)

            print("    DOC NAME:", oa["doc_name"])
            print("    CREATED:", oa.get("created_at"))

            if not na:
                print("    NEW STATUS: *** ATTACHMENT MISSING ***")
                missing_attachments.append(aid)

            else:
                print("    NEW ATTACHMENT ID:", na["id"])
                print("    attachableId:", na["attachableId"])
                print("    URL:", na["url"])
                print("    publicId:", na["publicId"])
                print("    bytes:", na["bytes"])

                if na["attachableId"] != np["id"]:
                    print("    *** WRONG PORTFOLIO RELATIONSHIP ***")
                    relationship_errors.append(aid)

                url = na.get("url") or ""
                public_id = na.get("publicId")

                valid_media_metadata = (
                    url.startswith("http")
                    and public_id
                )

                if not valid_media_metadata:
                    print("    *** MEDIA MISSING/BROKEN ***")
                    broken_media.append(aid)

            # ----------------------------------------------------
            # RECOVERY SOURCES FROM SAME OLD FILENAME
            # ----------------------------------------------------

            same_name = duplicates_by_name.get(oa["doc_name"], [])

            candidates = []

            for duplicate in same_name:

                if duplicate["id"] == aid:
                    continue

                candidate = new_attachments.get(duplicate["id"])

                if not candidate:
                    continue

                candidate_url = candidate.get("url") or ""
                candidate_public = candidate.get("publicId")

                if candidate_url.startswith("http") and candidate_public:
                    candidates.append((
                        duplicate,
                        candidate
                    ))

            if candidates:
                print()
                print("    POSSIBLE PROVEN RECOVERY SOURCES:")

                for duplicate, candidate in candidates:

                    print(
                        "      legacyAttachment=",
                        duplicate["id"],
                        "| oldPortfolio=",
                        duplicate["attachmentable_id"],
                        "| oldProfile=",
                        duplicate["profile_id"],
                        "| url=",
                        candidate["url"],
                        "| publicId=",
                        candidate["publicId"],
                        "| bytes=",
                        candidate["bytes"]
                    )

                if (not na) or not (
                    (na.get("url") or "").startswith("http")
                    and na.get("publicId")
                ):
                    recoverable.append(aid)

    print()
    print("=" * 120)
    print("SUMMARY")
    print("=" * 120)

    print("PORTFOLIOS:", len(portfolios))
    print("OLD ATTACHMENTS:", len(old_attachments))

    print("MISSING PORTFOLIOS:", sorted(set(missing_portfolios)))
    print("MISSING ATTACHMENTS:", sorted(set(missing_attachments)))
    print("BROKEN MEDIA:", sorted(set(broken_media)))
    print("BAD RELATIONSHIPS:", sorted(set(relationship_errors)))
    print(
        "BROKEN/MISSING WITH SAME-FILENAME RECOVERY:",
        sorted(set(recoverable))
    )

    print()
    print("SPECIAL CHECK — PORTFOLIO 914 / TITLE 12")

    p12 = new_portfolios.get(914)

    print("PORTFOLIO:", p12)

    a5204 = new_attachments.get(5204)

    print("ATTACHMENT 5204:", a5204)

    print()
    print("READ ONLY — NOTHING CHANGED")

finally:
    old.close()
    new.close()
