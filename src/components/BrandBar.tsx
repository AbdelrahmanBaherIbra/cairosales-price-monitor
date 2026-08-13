import Link from "next/link";

/** Cairo Sales branded header bar with the real logo. */
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
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="logo" src="/logo.jpeg" alt="Cairo Sales Stores" width={46} height={46} />
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
