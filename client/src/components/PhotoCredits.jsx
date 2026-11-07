import React from 'react';
import { creditList } from '../avatar.js';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

/**
 * "Photo credits": author, license (linked to its deed when it's Creative Commons) and the source page of every candidate
 * photo shown in this view. Required attribution for CC BY / CC BY-SA photos; reachable on every device (no hover needed).
 */
export default function PhotoCredits({ candidates }) {
  const list = creditList(candidates);
  if (!list.length) return null;
  return (
    <details className="photo-credits">
      <summary>Photo credits ({list.length})</summary>
      <ul>
        {list.map((c) => (
          <li key={c.sourcePage || c.name}>
            <b>{c.name}</b>
            {' — '}
            {c.credit ? `Photo: ${c.credit}` : 'Photo'}
            {c.license ? <>{' · '}{c.licenseUrl ? <a href={c.licenseUrl} {...ext}>{c.license}</a> : c.license}</> : null}
            {c.sourcePage ? <>{' · '}<a href={c.sourcePage} {...ext}>source</a></> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
