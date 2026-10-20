import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Health Notes — A little clarity for your health",
  description: "Bring your symptoms and health readings together. Explore an educational summary and thoughtful food suggestions.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
