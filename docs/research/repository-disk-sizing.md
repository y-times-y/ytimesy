# Repository disk sizing evidence

Verified 2026-10-04 with `agent-browser read`, including article HTML image alt text. Research only; no runtime or provisioning changes.

The available measurements do not establish that most developers need a 64 GiB disk. They measure repository storage, which is only one component of a working development VM. They also do not establish that a smaller disk will fit most production workflows.

## Original measurements

[Ryan Gibson, “Why the Hell Is This Git Repo So Large? And How to Trim It Down”](https://ryanagibson.com/posts/shrink-git-repo/), published July 29, 2024, reports an analysis of the 100 most starred GitHub projects. The histogram's alt text gives a median of approximately 91 MB for a full clone and 23 MB for a shallow clone; the 90th percentiles are approximately 1,136 MB and 327 MB respectively. After excluding repositories smaller than 2.5 MB, the medians are approximately 152 MB and 37 MB. The article describes these as clone disk usage, rather than installed or built project sizes.

This is a popularity-selected open-source sample, not a representative sample of developers, private enterprise projects, or installed environments. The inspected article does not give a complete reproducible collection script or dependency/build measurements. These 2024 observations demonstrate that source clones can be small even for well-known projects; they cannot support a population-wide claim about current VM disk requirements.

[GitHub, “Git clone: a data-driven study on cloning behaviors”](https://github.blog/open-source/git/git-clone-a-data-driven-study-on-cloning-behaviors/), published December 22, 2020 and updated March 12, 2021, reports repository disk sizes of 40 MB for jQuery, 750 MB for Swift, and 4,000 MB for Linux. Its controlled experiment used GitHub Enterprise Server 2.22 and Git 2.28.0. These are three deliberately selected repositories used to compare clone/fetch behavior, not a prevalence study. The study explicitly excludes repositories substantially larger than Linux and cautions that its synthetic workload does not represent daily development.

## What must be measured separately

A VM disk budget includes the base OS and desktop image, Git object database, checked-out files, installed dependencies, package/download caches, toolchains, generated build/test artifacts, local databases or container images, logs, and working headroom. A clone-size statistic cannot stand in for that total. Network clone payload, compressed Git objects, uncompressed checkout contents, and post-build disk usage are different measurements.

For selecting a default, measure actual used disk after boot, clone, dependency installation, and a representative build/test for the product's target repositories. Record peak usage during installation/build as well as final usage. Until that evidence exists, a default such as 64 GiB is a capacity choice, not an empirically demonstrated majority requirement. A smaller default with an explicit larger option or verified growth path is a hypothesis to evaluate, not a conclusion from repository-size data.
