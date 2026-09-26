/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Permissions-Policy",
            value: "local-network-access=(self), private-network-access=(self)",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
