import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/main.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="w-64 p-4">
      <h1 className="text-xl font-bold text-blue-600">D7 Admin Proxy</h1>
      <p className="text-sm text-gray-600 mt-2">Active on columbiadoctors.org</p>
    </div>
  </React.StrictMode>,
)
