"""Semantic versioning utilities for Starlark."""

def _parse_semver_part(part):
    """Parse a version part as an integer, or return -1 if not numeric.

    Args:
        part: String version component

    Returns:
        Integer value or -1 if not numeric
    """
    if part.isdigit():
        return int(part)
    return -1

def _parse_semver(version):
    """Parse a semver string into comparable components.

    Handles formats like:
    - 1.2.3
    - 1.2.3-alpha
    - 1.2.3-rc1
    - 1.2.3.4
    - 20210324.2
    - 0.0.0-20220923-a547704
    - 5.3.0-21.7
    - 6.0.0-rc1
    - 20230802.0.bcr.1

    Args:
        version: Version string

    Returns:
        Struct with major, minor, patch (all ints), and prerelease (string or None)
    """
    # Split on hyphen to separate version from prerelease/build metadata
    parts = version.split("-", 1)
    version_part = parts[0]
    prerelease = parts[1] if len(parts) > 1 else None

    # Split version on dots
    version_components = version_part.split(".")

    # Parse major, minor, patch (default to 0 if missing)
    major = _parse_semver_part(version_components[0]) if len(version_components) > 0 else 0
    minor = _parse_semver_part(version_components[1]) if len(version_components) > 1 else 0
    patch = _parse_semver_part(version_components[2]) if len(version_components) > 2 else 0

    # Handle 4th component (like 20210324.2 or 1.2.3.4)
    fourth = _parse_semver_part(version_components[3]) if len(version_components) > 3 else 0

    # Handle 5th component (like 20230802.0.bcr.1)
    fifth_str = version_components[4] if len(version_components) > 4 else ""

    return struct(
        major = major if major >= 0 else 0,
        minor = minor if minor >= 0 else 0,
        patch = patch if patch >= 0 else 0,
        fourth = fourth if fourth >= 0 else 0,
        fifth = fifth_str,
        prerelease = prerelease,
        original = version,
    )

def _compare_semver(v1, v2):
    """Compare two parsed semver structs.

    Args:
        v1: First parsed semver struct
        v2: Second parsed semver struct

    Returns:
        -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
    """
    # Compare major version
    if v1.major != v2.major:
        return 1 if v1.major > v2.major else -1

    # Compare minor version
    if v1.minor != v2.minor:
        return 1 if v1.minor > v2.minor else -1

    # Compare patch version
    if v1.patch != v2.patch:
        return 1 if v1.patch > v2.patch else -1

    # Compare fourth component
    if v1.fourth != v2.fourth:
        return 1 if v1.fourth > v2.fourth else -1

    # Compare fifth component (string comparison)
    if v1.fifth != v2.fifth:
        return 1 if v1.fifth > v2.fifth else -1

    # Handle prerelease versions
    # Per semver spec: 1.0.0-alpha < 1.0.0
    # Version without prerelease is greater than version with prerelease
    if v1.prerelease == None and v2.prerelease != None:
        return 1
    if v1.prerelease != None and v2.prerelease == None:
        return -1

    # Both have prerelease, compare lexicographically
    if v1.prerelease != None and v2.prerelease != None:
        if v1.prerelease != v2.prerelease:
            return 1 if v1.prerelease > v2.prerelease else -1

    return 0

def semver_max(versions):
    """Find the highest semantic version from a list.

    Args:
        versions: List of version strings

    Returns:
        The highest version string, or None if list is empty

    Example:
        semver_max(["1.2.3", "1.3.0", "1.2.4"]) -> "1.3.0"
        semver_max(["0.0.7", "0.0.5", "0.0.9"]) -> "0.0.9"
        semver_max(["6.0.0-rc1", "5.3.0-21.7", "4.0.0"]) -> "6.0.0-rc1"
    """
    if not versions:
        return None

    if len(versions) == 1:
        return versions[0]

    parsed_versions = [_parse_semver(v) for v in versions]

    max_version = parsed_versions[0]
    for v in parsed_versions[1:]:
        if _compare_semver(v, max_version) > 0:
            max_version = v

    return max_version.original

def semver_sort(versions):
    """Sort a list of semantic versions in ascending order.

    Args:
        versions: List of version strings

    Returns:
        Sorted list of version strings

    Example:
        semver_sort(["1.3.0", "1.2.3", "1.2.4"]) -> ["1.2.3", "1.2.4", "1.3.0"]
    """
    if not versions:
        return []

    parsed = [_parse_semver(v) for v in versions]

    # Simple bubble sort (Starlark doesn't have built-in sort)
    for i in range(len(parsed)):
        for j in range(len(parsed) - 1 - i):
            if _compare_semver(parsed[j], parsed[j + 1]) > 0:
                parsed[j], parsed[j + 1] = parsed[j + 1], parsed[j]

    return [v.original for v in parsed]
