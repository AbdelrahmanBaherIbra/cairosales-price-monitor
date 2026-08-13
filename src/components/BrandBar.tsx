import Link from "next/link";

/** Cairo Sales branded header bar with the round logo badge. */
export function BrandBar({
  title,
  tag,
  back,
}: {
  title: string;
  tag?: string;
  back?: boolean;
}) {
  return (
    <header className="brandbar">
      <div className="logo" aria-label="Cairo Sales Stores">
        <span>cairo</span>
        <span>sales</span>
        <span>stores</span>
      </div>
      <div className="brandtext">
        <h1>{title}</h1>
        {tag ? <div className="tag">{tag}</div> : null}
      </div>
      <div className="spacer" />
      {back ? (
        <Link href="/" className="backlink">
          ← All products
        </Link>
      ) : null}
    </header>
  );
}
