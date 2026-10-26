import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#176658', borderRadius: 8, fontFamily: '"Segoe UI","Microsoft YaHei",sans-serif', colorText: '#223b35', colorBgLayout: '#f6f8f6' } }}>
      <AntApp><App /></AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
