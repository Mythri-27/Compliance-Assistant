import "./globals.css";
import ConvexClientProvider from "./ConvexClientProvider";

export const metadata = { title: "Compliance RAG Assistant" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
