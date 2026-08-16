import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Board } from './Board.js';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('No #root element');

createRoot(root).render(
  <StrictMode>
    <Board />
  </StrictMode>,
);
