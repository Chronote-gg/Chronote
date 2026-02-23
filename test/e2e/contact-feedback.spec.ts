import { expect, test } from "./fixtures";
import { testIds } from "./pages/testIds";

test("contact feedback form submits and shows success (mock)", async ({
  page,
}) => {
  await page.goto("/feedback");
  await expect(page.getByTestId(testIds.contactFeedback.page)).toBeVisible();
  await expect(page.getByText("Send us feedback")).toBeVisible();

  const messageInput = page.getByTestId(testIds.contactFeedback.messageInput);
  const submitButton = page.getByTestId(testIds.contactFeedback.submitButton);

  // Submit button should be disabled when message is empty
  await expect(submitButton).toBeDisabled();

  // Fill in the message
  await messageInput.fill("This is a test feedback message from E2E tests.");
  await expect(submitButton).toBeEnabled();

  // Submit the form
  await submitButton.click();

  // Should show success message
  await expect(page.getByTestId(testIds.contactFeedback.success)).toBeVisible();
  await expect(page.getByText("Thank you for your feedback!")).toBeVisible();
});
