# TODO

## High priority

* Multi-org support
* Estimate of total migration time
* Percentage progress indicator, estimated completion time
* Repo details modal

## Medium priority

* Automate mapping of mannequin users
* Support migration to/from ghe.com 

## Low priority

* Migrate archived repos to separate org
* Modal configuration of credentials and orgs
* Make it deployable with persistent state

## Task 001 - improved worker thread ui

Instead of boxes for the three worker threads I want one box with the workers listed one per line.
Status worker should be renamed Checker
Migration worker should be renamed Queuer
Progress worker should be renamed Reporter
Each line should have leftaligned the worker name first, then the current status of the worker, both in same font and weight as now. Then a smaller button rightaligned.
