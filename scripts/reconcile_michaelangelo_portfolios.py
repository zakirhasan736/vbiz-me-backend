#!/usr/bin/env python3

import os
import sys
import uuid
import argparse
from urllib.parse import urlparse, unquote

import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor


PROFILE_LEGACY_ID = 91
PROFILE_ID = "cmsuup13204ubcnkcdd5m3dgy"

# Existing PostgreSQL Portfolio rows proven by migration sequence.
EXISTING_LINKS = {
    916: "cmtgtwr5l001l4ckcpapmqj6s",  # sortOrder 0, title 14
    914: "cmtgtwr5n001m4ckcqytt7u0g",  # sortOrder 1, title 12
    913: "cmtgtwr5q001n4ckcwf488ry4",  # sortOrder 2, Screenshot
    783: "cmtgtwr5w001p4ckc5nz7em4a",  # sortOrder 4, first title 8
    433: "cmtgtwr60001q4ckcjicdoyzx",  # sortOrder 5, second title 8
}

EXPECTED_EXISTING = {
    916: ("14", 0),
    914: ("12", 1),
    913: ("vBiz Me Screenshot", 2),
    783: ("8", 4),
    433: ("8", 5),
}

MISSING_PORTFOLIOS = {125, 912, 915}

# Existing PostgreSQL Attachment rows requiring parent repair.
ATTACHMENT_LINKS = {
    858: 125,
    2419: 433,
    4599: 783,
    5198: 912,
    5199: 913,
    5204: 914,
    5205: 915,
    5206: 916,
}

MISSING_ATTACHMENT_ID = 1013


def new_id():
    return "c" + uuid.uuid4().hex[:24]


def connect_mysql():
    return pymysql.connect(
        host=os.environ["OLD_MYSQL_HOST"],
        port=int(os.environ.get("OLD_MYSQL_PORT", "3306")),
        user=os.environ["OLD_MYSQL_USER"],
        password=os.environ["OLD_MYSQL_PASSWORD"],
        database=os.environ["OLD_MYSQL_DATABASE"],
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        ssl_disabled=True,
    )


def section(title):
    print()
    print("=" * 90)
    print(title)
    print("=" * 90)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    mysql = connect_mysql()
    pg = psycopg2.connect(os.environ["NEW_DATABASE_URL"])

    portfolio_map = {}

    try:
        # --------------------------------------------------
        # Profile verification
        # --------------------------------------------------
        with pg.cursor(cursor_factory=RealDictCursor) as c:
            c.execute("""
                SELECT id, "legacyId", name, slug
                FROM "Profile"
                WHERE id=%s
            """, (PROFILE_ID,))
            profile = c.fetchone()

        if not profile:
            raise RuntimeError("Michaelangelo PostgreSQL Profile missing")

        if profile["legacyId"] != PROFILE_LEGACY_ID:
            raise RuntimeError(
                f"Wrong Profile legacyId: {profile['legacyId']}"
            )

        section("1. VERIFY EXISTING PORTFOLIO LINKS")

        # --------------------------------------------------
        # Verify the 5 existing rows before linking.
        # --------------------------------------------------
        with pg.cursor(cursor_factory=RealDictCursor) as c:
            for legacy_id, new_id_value in EXISTING_LINKS.items():

                c.execute("""
                    SELECT
                        id,
                        "legacyId",
                        "profileId",
                        title,
                        "sortOrder",
                        "imageUrl",
                        "attachmentUrl",
                        "attachmentName"
                    FROM "Portfolio"
                    WHERE id=%s
                """, (new_id_value,))

                row = c.fetchone()

                if not row:
                    raise RuntimeError(
                        f"Expected Portfolio {new_id_value} missing"
                    )

                expected_title, expected_sort = EXPECTED_EXISTING[legacy_id]

                if row["profileId"] != PROFILE_ID:
                    raise RuntimeError(
                        f"Portfolio {new_id_value} wrong profile"
                    )

                if row["legacyId"] not in (None, legacy_id):
                    raise RuntimeError(
                        f"Portfolio {new_id_value} already owns "
                        f"legacyId={row['legacyId']}"
                    )

                if (row["title"] or "") != expected_title:
                    raise RuntimeError(
                        f"Portfolio {new_id_value}: title mismatch "
                        f"{row['title']!r} != {expected_title!r}"
                    )

                if row["sortOrder"] != expected_sort:
                    raise RuntimeError(
                        f"Portfolio {new_id_value}: sortOrder mismatch "
                        f"{row['sortOrder']} != {expected_sort}"
                    )

                c.execute("""
                    SELECT id
                    FROM "Portfolio"
                    WHERE "legacyId"=%s
                      AND id<>%s
                """, (legacy_id, new_id_value))

                duplicate = c.fetchone()

                if duplicate:
                    raise RuntimeError(
                        f"legacyId {legacy_id} already belongs to "
                        f"{duplicate['id']}"
                    )

                portfolio_map[legacy_id] = new_id_value

                print(
                    f"LINK existing OLD {legacy_id} "
                    f"-> NEW {new_id_value} "
                    f"title={row['title']!r} "
                    f"sortOrder={row['sortOrder']}"
                )

        # --------------------------------------------------
        # Already-proven six mappings
        # --------------------------------------------------
        section("2. LOAD ALREADY-PROVEN PORTFOLIOS")

        with pg.cursor(cursor_factory=RealDictCursor) as c:
            c.execute("""
                SELECT id, "legacyId", title
                FROM "Portfolio"
                WHERE "profileId"=%s
                  AND "legacyId" IN (
                    121,123,430,431,432,852
                  )
                ORDER BY "legacyId"
            """, (PROFILE_ID,))

            rows = c.fetchall()

        if len(rows) != 6:
            raise RuntimeError(
                f"Expected 6 proven portfolios, found {len(rows)}"
            )

        for row in rows:
            portfolio_map[int(row["legacyId"])] = row["id"]
            print(
                f"KEEP OLD {row['legacyId']} "
                f"-> NEW {row['id']} "
                f"title={row['title']!r}"
            )

        # --------------------------------------------------
        # Create plan for genuinely missing 125/912/915
        # --------------------------------------------------
        section("3. PLAN GENUINELY MISSING PORTFOLIOS")

        with mysql.cursor() as c:
            placeholders = ",".join(
                ["%s"] * len(MISSING_PORTFOLIOS)
            )

            c.execute(
                f"""
                SELECT *
                FROM portfolios
                WHERE id IN ({placeholders})
                ORDER BY id
                """,
                sorted(MISSING_PORTFOLIOS),
            )

            old_missing = {
                int(r["id"]): r
                for r in c.fetchall()
            }

        if set(old_missing) != MISSING_PORTFOLIOS:
            raise RuntimeError(
                "One or more missing OLD Portfolio rows were not found"
            )

        with pg.cursor(cursor_factory=RealDictCursor) as c:
            for legacy_id in sorted(MISSING_PORTFOLIOS):
                c.execute("""
                    SELECT *
                    FROM "Portfolio"
                    WHERE "legacyId"=%s
                """, (legacy_id,))

                if c.fetchone():
                    raise RuntimeError(
                        f"Portfolio legacyId {legacy_id} unexpectedly exists"
                    )

                old = old_missing[legacy_id]
                new_portfolio_id = new_id()

                portfolio_map[legacy_id] = new_portfolio_id

                print(
                    f"CREATE OLD {legacy_id} "
                    f"-> NEW {new_portfolio_id} "
                    f"title={old.get('title')!r}"
                )

                if args.apply:
                    c.execute("""
                        INSERT INTO "Portfolio" (
                            id,
                            "legacyId",
                            "profileId",
                            title,
                            description,
                            status,
                            "sortOrder",
                            url,
                            "imageUrl",
                            "attachmentUrl",
                            "attachmentName",
                            "createdAt",
                            "updatedAt"
                        )
                        VALUES (
                            %s,%s,%s,%s,%s,%s,%s,%s,
                            NULL,NULL,NULL,%s,%s
                        )
                    """, (
                        new_portfolio_id,
                        legacy_id,
                        PROFILE_ID,
                        old.get("title"),
                        old.get("description"),
                        int(bool(old.get("status"))),
                        0,
                        old.get("url"),
                        old.get("created_at"),
                        old.get("updated_at")
                            or old.get("created_at"),
                    ))

        # --------------------------------------------------
        # Link five existing Portfolio rows
        # --------------------------------------------------
        section("4. PLAN LEGACY-ID LINKS")

        with pg.cursor() as c:
            for legacy_id, new_portfolio_id in EXISTING_LINKS.items():

                print(
                    f"SET Portfolio {new_portfolio_id} "
                    f"legacyId={legacy_id}"
                )

                if args.apply:
                    c.execute("""
                        UPDATE "Portfolio"
                        SET "legacyId"=%s
                        WHERE id=%s
                          AND (
                              "legacyId" IS NULL
                              OR "legacyId"=%s
                          )
                    """, (
                        legacy_id,
                        new_portfolio_id,
                        legacy_id,
                    ))

                    if c.rowcount != 1:
                        raise RuntimeError(
                            f"Failed Portfolio legacy link {legacy_id}"
                        )

        # --------------------------------------------------
        # Verify OLD attachment ownership
        # --------------------------------------------------
        section("5. PLAN ATTACHMENT RELINKS")

        with mysql.cursor() as mc, \
             pg.cursor(cursor_factory=RealDictCursor) as pc:

            for attachment_legacy_id, portfolio_legacy_id \
                    in ATTACHMENT_LINKS.items():

                mc.execute("""
                    SELECT *
                    FROM attachments
                    WHERE id=%s
                """, (attachment_legacy_id,))

                old_att = mc.fetchone()

                if not old_att:
                    raise RuntimeError(
                        f"OLD Attachment {attachment_legacy_id} missing"
                    )

                if int(old_att["attachmentable_id"]) != portfolio_legacy_id:
                    raise RuntimeError(
                        f"OLD Attachment {attachment_legacy_id} "
                        f"wrong Portfolio parent"
                    )

                if "Portfolio" not in (
                    old_att.get("attachmentable_type") or ""
                ):
                    raise RuntimeError(
                        f"OLD Attachment {attachment_legacy_id} "
                        f"is not Portfolio attachment"
                    )

                pc.execute("""
                    SELECT *
                    FROM "Attachment"
                    WHERE "legacyId"=%s
                """, (attachment_legacy_id,))

                pg_att = pc.fetchone()

                if not pg_att:
                    raise RuntimeError(
                        f"NEW Attachment legacyId "
                        f"{attachment_legacy_id} missing"
                    )

                target_portfolio_id = portfolio_map[
                    portfolio_legacy_id
                ]

                print(
                    f"RELINK Attachment {attachment_legacy_id}: "
                    f"{pg_att['attachableId']} "
                    f"-> {target_portfolio_id} "
                    f"(Portfolio {portfolio_legacy_id})"
                )

                if args.apply:
                    pc.execute("""
                        UPDATE "Attachment"
                        SET
                            "attachableId"=%s,
                            "profileId"=%s,
                            "attachableType"='App\\Models\\Portfolio'
                        WHERE "legacyId"=%s
                    """, (
                        target_portfolio_id,
                        PROFILE_ID,
                        attachment_legacy_id,
                    ))

                    if pc.rowcount != 1:
                        raise RuntimeError(
                            f"Attachment relink failed "
                            f"{attachment_legacy_id}"
                        )

        # --------------------------------------------------
        # Missing Attachment 1013
        # --------------------------------------------------
        section("6. MISSING ATTACHMENT 1013 — DEFERRED")

        with mysql.cursor() as mc:
            mc.execute("""
                SELECT *
                FROM attachments
                WHERE id=%s
            """, (MISSING_ATTACHMENT_ID,))

            old_att = mc.fetchone()

        if not old_att:
            raise RuntimeError("OLD Attachment 1013 missing")

        if int(old_att["attachmentable_id"]) != 125:
            raise RuntimeError(
                "Attachment 1013 does not belong to Portfolio 125"
            )

        with pg.cursor(cursor_factory=RealDictCursor) as c:
            c.execute("""
                SELECT *
                FROM "Attachment"
                WHERE "legacyId"=%s
            """, (MISSING_ATTACHMENT_ID,))

            existing = c.fetchone()

        if existing:
            raise RuntimeError(
                "Attachment legacyId 1013 unexpectedly exists"
            )

        print("DEFER Attachment 1013")
        print(f"  parent OLD Portfolio: 125")
        print(f"  target NEW Portfolio: {portfolio_map[125]}")
        print(f"  docName={old_att['doc_name']!r}")
        print("  reason=source media URL/file not yet proven")
        print("  NOTHING WILL BE INSERTED FOR 1013")

        # --------------------------------------------------
        # Repair only the two Portfolio media URLs that are
        # already backed by known valid migrated S3 objects.
        # --------------------------------------------------
        section("7. PROVEN S3 PORTFOLIO MEDIA REPAIRS")

        for portfolio_legacy_id, attachment_legacy_id in (
            (433, 2419),
            (783, 4599),
        ):
            with pg.cursor(cursor_factory=RealDictCursor) as c:
                c.execute("""
                    SELECT
                        url,
                        "publicId",
                        "docName"
                    FROM "Attachment"
                    WHERE "legacyId"=%s
                """, (attachment_legacy_id,))

                att = c.fetchone()

                if not att:
                    raise RuntimeError(
                        f"Attachment {attachment_legacy_id} missing"
                    )

                url = (att["url"] or "").strip()

                if not url.startswith(("http://", "https://")):
                    raise RuntimeError(
                        f"Attachment {attachment_legacy_id} "
                        f"does not have valid HTTP media URL"
                    )

                target = portfolio_map[portfolio_legacy_id]

                print(
                    f"MEDIA Portfolio {portfolio_legacy_id}: "
                    f"{url}"
                )

                if args.apply:
                    c.execute("""
                        UPDATE "Portfolio"
                        SET
                            "imageUrl"=%s,
                            "attachmentUrl"=%s,
                            "attachmentName"=%s
                        WHERE id=%s
                    """, (
                        url,
                        url,
                        att["docName"],
                        target,
                    ))

                    if c.rowcount != 1:
                        raise RuntimeError(
                            f"Portfolio media update failed "
                            f"{portfolio_legacy_id}"
                        )

        # --------------------------------------------------
        # Summary
        # --------------------------------------------------
        section("8. FINAL PLAN")

        for legacy_id in sorted(portfolio_map):
            print(
                f"OLD Portfolio {legacy_id:>3} "
                f"-> NEW {portfolio_map[legacy_id]}"
            )

        print()
        print("Expected Portfolio identities:", len(portfolio_map))
        print("Expected:", 14)

        if len(portfolio_map) != 14:
            raise RuntimeError(
                "Portfolio map did not reach 14"
            )

        if args.apply:
            pg.commit()
            print()
            print("COMMITTED SUCCESSFULLY")
        else:
            pg.rollback()
            print()
            print("DRY RUN ONLY — NOTHING CHANGED")

    except Exception:
        pg.rollback()
        raise

    finally:
        mysql.close()
        pg.close()


if __name__ == "__main__":
    main()
