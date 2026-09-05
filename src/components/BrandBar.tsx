import Link from "next/link";

/** Cairo Sales branded header bar with the real logo. */
export function BrandBar({
  title,
  tag,
  back,
  link,
}: {
  title: string;
  tag?: string;
  back?: boolean;
  /** Optional forward link, e.g. from the dashboard to the analytics page. */
  link?: { href: string; label: string };
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
      {link ? (
        <Link href={link.href} className="backlink">
          {link.label}
        </Link>
      ) : null}
      {back ? (
        <Link href="/" className="backlink">
          ← All products
        </Link>
      ) : null}
    </header>
  );
}
