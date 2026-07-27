import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import reportWebVitals from "./reportWebVitals";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { AuthProvider } from "./contexts/AuthContext";
import { theme } from "./theme";
import { GuildProvider } from "./contexts/GuildContext";
import { QueryClientProvider } from "@tanstack/react-query";
import { trpc } from "./services/trpc";
import { trpcClient } from "./services/trpcClient";
import { queryClient } from "./queryClient";
import { initAnalytics } from "./services/analytics";

initAnalytics();

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

root.render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <GuildProvider>
              <App />
            </GuildProvider>
            <Notifications position="top-right" />
          </AuthProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </MantineProvider>
  </React.StrictMode>,
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
