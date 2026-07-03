import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { PreferencesProvider } from "../theme/preferences.js";
import { AppRoutes } from "./routes.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } }
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>
        <BrowserRouter><AppRoutes /></BrowserRouter>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}
