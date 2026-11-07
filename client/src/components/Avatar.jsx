import React, { useState } from 'react';
import { initials, avatarTone, photoCredit } from '../avatar.js';

/**
 * A candidate's circle, left of the name: initials on a party tint, or the photo the server attached (it only attaches
 * reviewed photos, and only when every major candidate in the contest has one). The photo's credit and license show on
 * hover / focus; `interactive={false}` inside map tooltips, which can't be hovered (they list credits in a footer).
 */
export default function Avatar({ name, party, photo, size = 28, interactive = true }) {
  const [failed, setFailed] = useState(false);
  const tone = avatarTone(party);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4), background: tone.bg, color: tone.fg, borderColor: tone.ring };
  if (photo?.url && !failed) {
    const credit = photoCredit(photo);
    return (
      <span className={`av av-photo${interactive ? ' av-int' : ''}`} style={style} tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? `Photo of ${name}. ${credit}` : undefined}>
        <img src={photo.url} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        {interactive && (
          <span className="av-credit" role="tooltip">
            {credit}
            {photo.sourcePage ? (
              <a className="av-src" href={photo.sourcePage} target="_blank" rel="noopener noreferrer">
                Source: {photo.sourcePage.replace(/^https?:\/\//, '').replace(/^commons\.wikimedia\.org\/wiki\//, 'Commons ').slice(0, 60)}
              </a>
            ) : null}
          </span>
        )}
      </span>
    );
  }
  return <span className="av" style={style} aria-hidden="true">{initials(name)}</span>;
}
