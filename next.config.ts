import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

// Never emit a filesystem-backed Local World on a hosted deployment.
if (process.env.VERCEL === '1' && !process.env.VERCEL_DEPLOYMENT_ID) {
  throw new Error('Workflow requires Vercel System Environment Variables.');
}

const nextConfig: NextConfig = {
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180
    },
    browserDebugInfoInTerminal: true,
    globalNotFound: true
  },
  poweredByHeader: false
};
export default withWorkflow(nextConfig);
