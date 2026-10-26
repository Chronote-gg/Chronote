/* global module */
/** @param {string} left @param {string} right */
function sameEcsTaskArn(left, right) {
  const pattern =
    /^arn:(aws(?:-[a-z]+)*):ecs:([a-z0-9-]+):(\d{12}):task\/(?:(\w[\w-]*)\/)?([a-zA-Z0-9-]+)$/;
  const a = pattern.exec(left);
  const b = pattern.exec(right);
  return Boolean(
    a &&
    b &&
    [1, 2, 3, 5].every((index) => a[index] === b[index]) &&
    (!a[4] || !b[4] || a[4] === b[4]),
  );
}
module.exports = { sameEcsTaskArn };
