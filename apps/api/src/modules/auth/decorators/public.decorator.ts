import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/** No session required. Everything else is private by default (see AuthGuard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
