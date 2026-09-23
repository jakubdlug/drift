import { mount } from 'svelte'
import App from './App.svelte'
import FindBar from './components/FindBar.svelte'
import './app.css'

mount(location.hash === '#find' ? FindBar : App, { target: document.getElementById('app')! })
