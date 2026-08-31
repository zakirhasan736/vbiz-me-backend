#!/usr/bin/env python3

import os
import argparse
import psycopg2
from psycopg2.extras import RealDictCursor

PROFILE_ID = "cmsuup13204ubcnkcdd5m3dgy"

REPAIRS = {
    5198: {
        "portfolioLegacyId": 912,
        "key": "vbizme/portfolios/1787054860858-featured_1787052350_6a84413ea1504.jpg",
        "size": 99195,
    },
    5199: {
        "portfolioLegacyId": 913,
        "key": "vbizme/portfolios/1787054860289-featured_1787052578_6a844222cc1e1.jpg",
        "size": 125645,
    },
}

BASE = "https://aws-s3-vbizme-vcard.s3.us-east-2.amazonaws.com/"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    pg = psycopg2.connect(os.environ["NEW_DATABASE_URL"])

    try:
        with pg.cursor(cursor_factory=RealDictCursor) as c:

            for attachment_legacy_id, info in REPAIRS.items():

                c.execute("""
                    SELECT
                        a.id,
                        a."legacyId",
                        a."attachableId",
                        a."profileId",
                        a."docName",
                        a.url,
                        a."publicId",
                        a.bytes,
                        p.id AS "portfolioId",
                        p."legacyId" AS "portfolioLegacyId",
                        p.title
                    FROM "Attachment" a
                    JOIN "Portfolio" p
                      ON p.id = a."attachableId"
                    WHERE a."legacyId"=%s
                """, (attachment_legacy_id,))

                row = c.fetchone()

                if not row:
                    raise RuntimeError(
                        f"Attachment {attachment_legacy_id} missing"
                    )

                if row["profileId"] != PROFILE_ID:
                    raise RuntimeError(
                        f"Attachment {attachment_legacy_id}: wrong profile"
                    )

                if row["portfolioLegacyId"] != info["portfolioLegacyId"]:
                    raise RuntimeError(
                        f"Attachment {attachment_legacy_id}: "
                        f"wrong Portfolio relationship"
                    )

                expected_filename = row["docName"]

                s3_basename = info["key"].rsplit("/", 1)[-1]

                if not s3_basename.endswith(expected_filename):
                    raise RuntimeError(
                        f"Attachment {attachment_legacy_id}: "
                        f"S3 key does not end with docName: "
                        f"{s3_basename!r} vs {expected_filename!r}"
                    )

                url = BASE + info["key"]

                print("=" * 80)
                print(
                    f"Attachment {attachment_legacy_id} "
                    f"-> Portfolio {info['portfolioLegacyId']}"
                )
                print("Portfolio:", row["title"])
                print("File:", expected_filename)
                print("S3 key:", info["key"])
                print("URL:", url)
                print("Bytes:", info["size"])

                if args.apply:

                    c.execute("""
                        UPDATE "Attachment"
                        SET
                            url=%s,
                            "publicId"=%s,
                            "resourceType"='image',
                            format='jpg',
                            bytes=%s,
                            extension='jpg',
                            "mimeType"='image/jpeg'
                        WHERE "legacyId"=%s
                          AND "attachableId"=%s
                    """, (
                        url,
                        info["key"],
                        info["size"],
                        attachment_legacy_id,
                        row["portfolioId"],
                    ))

                    if c.rowcount != 1:
                        raise RuntimeError(
                            f"Attachment {attachment_legacy_id} "
                            f"update failed"
                        )

                    c.execute("""
                        UPDATE "Portfolio"
                        SET
                            "imageUrl"=%s,
                            "attachmentUrl"=%s,
                            "attachmentName"=%s
                        WHERE id=%s
                          AND "legacyId"=%s
                          AND "profileId"=%s
                    """, (
                        url,
                        url,
                        expected_filename,
                        row["portfolioId"],
                        info["portfolioLegacyId"],
                        PROFILE_ID,
                    ))

                    if c.rowcount != 1:
                        raise RuntimeError(
                            f"Portfolio {info['portfolioLegacyId']} "
                            f"update failed"
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
        pg.close()


if __name__ == "__main__":
    main()
