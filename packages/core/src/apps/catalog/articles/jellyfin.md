## Your own media library

Jellyfin serves your videos, music, and other media through its web UI and supported clients. The template pulls its official pinned container and uses persistent config, cache, and media volumes. It does not mount host directories or grant GPU, Docker socket, or privileged access.

## First login

Choose an initial administrator username. Openship generates and encrypts the password. The startup helper finishes Jellyfin's setup against a loopback-only listener before starting public access. Existing configuration and changed passwords remain intact on redeployment. Find the initial credentials in **Connection**.

This template requires Openship 0.9.2 or newer for the declarative container entrypoint override. Older instances must upgrade before installing it; they must not run an uninitialized public setup wizard.

## Add media

Copy your own media into the persistent `/media` volume, then add libraries pointing to those folders in Jellyfin's dashboard. Media is not supplied by the template. The `/config` volume contains users, libraries, and metadata; back it up with the media. Cache is disposable.

Allow at least 2 CPU cores and 2 GiB RAM. Software transcoding can require considerably more CPU; direct playback uses less. These are recommendations, not runtime limits. Hardware acceleration and LAN discovery require explicit operator configuration and are not enabled by this template.

[Official container guide](https://jellyfin.org/docs/general/installation/container/) · [Jellyfin source](https://github.com/jellyfin/jellyfin)
