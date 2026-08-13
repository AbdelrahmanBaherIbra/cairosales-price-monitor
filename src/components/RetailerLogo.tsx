"use client";

import { useState } from "react";

/** Root domain from a website URL, e.g. https://www.noon.com/egypt-en -> noon.com */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Retailer favicon on a small white chip so it stays legible on the red
 * table header. Falls back to a brand-coloured initial if the icon 404s.
 */
export function RetailerLogo({
  name,
  websiteUrl,
}: {
  name: string;
  websiteUrl: string | null;
}) {
  const host = hostOf(websiteUrl);
  const [failed, setFailed] = useState(false);

  if (!host || failed) {
    return (
      <span className="rlogo rlogo-fallback" aria-hidden="true">
        {name.charAt(0)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="rlogo"
      src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
      alt=""
      width={18}
      height={18}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
