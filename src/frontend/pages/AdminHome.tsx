import {
  Alert,
  Button,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconMessageCircle,
  IconSettings,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import Surface from "../components/Surface";
import { useAuth } from "../contexts/AuthContext";

function AdminHomeAccessDenied() {
  return (
    <Surface tone="soft" p="xl">
      <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light">
        Super admin access is required to view this page.
      </Alert>
    </Surface>
  );
}

export default function AdminHome() {
  const { user } = useAuth();
  const isSuperAdmin = Boolean(user?.isSuperAdmin);

  if (!isSuperAdmin) {
    return <AdminHomeAccessDenied />;
  }

  return (
    <Stack gap="lg" data-testid="admin-home-page">
      <Stack gap={4}>
        <Title order={2}>Admin console</Title>
        <Text size="sm" c="dimmed">
          Super admin tools for global configuration and feedback.
        </Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Surface tone="raised" p="lg">
          <Stack gap="md">
            <Group gap="sm">
              <ThemeIcon variant="light" color="brand" size={40}>
                <IconSettings size={20} />
              </ThemeIcon>
              <Stack gap={0}>
                <Text fw={600}>Admin configuration</Text>
                <Text size="sm" c="dimmed">
                  Manage global defaults and overrides.
                </Text>
              </Stack>
            </Group>
            <Button
              component={Link}
              to="/admin/config"
              variant="light"
              color="brand"
              data-testid="admin-home-config"
            >
              Open configuration
            </Button>
          </Stack>
        </Surface>
        <Surface tone="raised" p="lg">
          <Stack gap="md">
            <Group gap="sm">
              <ThemeIcon variant="light" color="brand" size={40}>
                <IconMessageCircle size={20} />
              </ThemeIcon>
              <Stack gap={0}>
                <Text fw={600}>Admin feedback</Text>
                <Text size="sm" c="dimmed">
                  Review feedback from summaries and Ask answers.
                </Text>
              </Stack>
            </Group>
            <Button
              component={Link}
              to="/admin/feedback"
              variant="light"
              color="brand"
              data-testid="admin-home-feedback"
            >
              Open feedback
            </Button>
          </Stack>
        </Surface>
      </SimpleGrid>
    </Stack>
  );
}
