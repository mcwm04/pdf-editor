import './styles.css';
import { startApp } from './ui/app';
import { loadScreenFonts } from './core/fonts';

// Urdu fonts are bundled in the page; register them before the first page is drawn.
loadScreenFonts().finally(() => startApp());
