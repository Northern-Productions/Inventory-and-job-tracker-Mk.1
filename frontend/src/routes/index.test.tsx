import { isValidElement } from 'react';
import { Navigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { appRoutes } from './appRoutes';

describe('app routes', () => {
  it('redirects the retired owner admin permissions page to the access page', () => {
    const rootRoute = appRoutes.find((route) => route.path === '/');
    const ownerAdminPermissionsRoute = rootRoute?.children?.find(
      (route) => route.path === '/owner/admin-permissions'
    );
    const redirectElement = ownerAdminPermissionsRoute?.element;

    expect(ownerAdminPermissionsRoute).toBeDefined();
    expect(isValidElement(redirectElement)).toBe(true);

    if (!isValidElement(redirectElement)) {
      throw new Error('Expected /owner/admin-permissions to render a redirect element.');
    }

    expect(redirectElement.type).toBe(Navigate);
    expect(redirectElement.props.to).toBe('/admin/access');
    expect(redirectElement.props.replace).toBe(true);
  });
});
