import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ROOT } from './api'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter basename={ROOT}><App /></BrowserRouter></StrictMode>,
)
