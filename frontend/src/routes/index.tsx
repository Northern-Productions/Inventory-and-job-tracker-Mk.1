import { createHashRouter } from 'react-router-dom';
import { appRoutes } from './appRoutes';

export const router = createHashRouter(appRoutes);
