import React from 'react';
import ReactDOM from 'react-dom/client';
import { inject as injectAnalytics } from '@vercel/analytics';
import App from './App';

injectAnalytics();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
