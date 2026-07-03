import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyChartTheme } from './utils/chartTheme';

// Chart.js merender ke <canvas>, CSS tidak bisa menjangkaunya — samakan warna
// default tick/legend/grid dengan token tema aktif sebelum chart manapun dibuat.
applyChartTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
