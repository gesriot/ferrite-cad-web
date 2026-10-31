import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { DocumentLeaveGuard } from "@/components/cad/DocumentLeaveGuard";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Ferrite CAD" },
      {
        name: "description",
        content: "Browser CAD with STEP assemblies and a supported FCAD editing workflow.",
      },
      { name: "theme-color", content: "#141210" },
      { property: "og:title", content: "Ferrite CAD" },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "/og.jpg" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  component: () => (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <DocumentLeaveGuard />
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
