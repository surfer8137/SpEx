import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'SpEx: Sprite Extruder',
  description: 'Turn any sprite PNG into a low-poly extruded 3D model — ready to export as GLB or OBJ.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        {/* OpenCV.js loaded after page is interactive */}
        <Script
          src="https://docs.opencv.org/4.x/opencv.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
