import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Board } from './Board.js';
// Bundled, not fetched. The board is local-first and has to look the same
// with no network, which a webfont from someone else's CDN cannot promise.
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('No #root element');

createRoot(root).render(
  <StrictMode>
    <Board />
  </StrictMode>,
);
