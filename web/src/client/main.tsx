import { render } from 'preact';
import { rewriteLegacyUrl } from './shell/router';
import { Shell } from './shell/Shell';
import './styles.css';

rewriteLegacyUrl();
render(<Shell />, document.getElementById('app')!);
